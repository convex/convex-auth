/**
 * Tests the `passkey` method end to end: a user whom another method signed
 * up adds a passkey, then signs in with it without a username. No username
 * component is registered.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  internalMutationGeneric,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ORIGIN,
  RP_ID,
  buildAssertion,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  registrationResponse,
  toBase64URL,
  type TestCredential,
} from "@convex-dev/passkey-test-authenticator";
import type { ComponentApi } from "../../component/_generated/component.ts";
import type { ComponentApi as PasskeyComponentApi } from "../../components/passkey/_generated/component.ts";
import type { CreateUserFn, TokenBundle } from "../../lib/types.ts";
import { registerCore, sessionIdentity } from "../../testing/core.ts";
import { registerPasskey } from "../../testing/passkey.ts";
import { getAuthenticationTime } from "../../server/reauthentication.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { setupPasskey, type GetUserNameFn } from "./server.ts";

const components = componentsGeneric() as unknown as {
  auth: ComponentApi<"auth">;
  authPasskey: PasskeyComponentApi;
  authEmail: object;
};

const core = setupConvexAuth({ component: components.auth });

// Stands in for the method that creates the account, for example an email
// and a password. The account id of the test is the user id.
const { authMutation } = core.bindMethod({
  name: "email",
  createUser: makeFunctionReference<"mutation">(
    "testApp:createUser",
  ) as unknown as CreateUserFn<"email", unknown, "users">,
});

const createUser = internalMutationGeneric({
  args: { method: v.object({ name: v.string(), profile: v.any() }) },
  returns: v.string(),
  handler: async (_ctx, args) => args.method.profile.id,
});

const signUpWithEmail = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.convexAuth.completeSignUp({
      profile: { id: accountId },
      authenticatedBy: components.authEmail,
    }),
});

const getUserName = queryGeneric({
  args: { userId: v.string() },
  returns: v.object({ name: v.string(), displayName: v.string() }),
  // A user named "nameless" stands for a bug of the app.
  handler: async (_ctx, { userId }) =>
    userId === "nameless"
      ? { name: "", displayName: "" }
      : { name: `${userId}@example.com`, displayName: `User ${userId}` },
});

const MAX_AGE_SECONDS = 10 * 60;

const passkey = setupPasskey(core, {
  component: components.authPasskey,
  rpId: RP_ID,
  origin: ORIGIN,
  rpName: "Test app",
}).attachUserCallbacks({
  getUserName: makeFunctionReference<"query">(
    "testApp:getUserName",
  ) as unknown as GetUserNameFn<"users">,
});

const authenticationTime = queryGeneric({
  args: {},
  returns: v.any(),
  handler: async (ctx) => await getAuthenticationTime(ctx),
});

const testApp = {
  createUser,
  signUpWithEmail,
  getUserName,
  authenticationTime,
  ...passkey,
};

const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

const START = new Date("2026-01-01T00:00:00Z").getTime();
const MINUTE = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const t = convexTest(undefined, modules);
  registerCore(t);
  registerPasskey(t);
  return t;
}

type T = ReturnType<typeof setup>;

const ref = <Type extends "query" | "mutation">(
  type: Type,
  name: keyof typeof testApp,
) => makeFunctionReference<Type>(`testApp:${name}`);

const as = (t: T, tokens: TokenBundle) =>
  t.withIdentity(sessionIdentity(tokens));

async function signUp(t: T, accountId: string): Promise<TokenBundle> {
  return await t.mutation(ref("mutation", "signUpWithEmail"), { accountId });
}

async function attest(challenge: string, credential: TestCredential) {
  const authenticatorData = await buildAuthenticatorData({
    rpId: RP_ID,
    credential,
  });
  return {
    response: registrationResponse({
      credential,
      attestationObject: buildAttestationObject(authenticatorData),
      clientDataJSON: buildClientDataJSON({
        type: "webauthn.create",
        challenge,
        origin: ORIGIN,
      }),
    }),
  };
}

const assertWith = (credential: TestCredential, challenge: string) =>
  buildAssertion(credential, challenge, { rpId: RP_ID, origin: ORIGIN });

/** Run the whole add flow and return the new passkey. */
async function addPasskey(t: T, tokens: TokenBundle) {
  const caller = as(t, tokens);
  const start = await caller.mutation(ref("mutation", "startAddPasskey"), {});
  if (!start.success) {
    throw new Error(`The add could not start: ${start.userError.error}`);
  }
  const credential = await generateES256Credential();
  const finished = await caller.mutation(
    ref("mutation", "finishAddPasskey"),
    await attest(start.options.challenge, credential),
  );
  if (!finished.success) {
    throw new Error(`The add failed: ${finished.userError.error}`);
  }
  return { passkeyId: finished.passkeyId as string, credential };
}

/** Run the whole sign-in flow with `credential`. */
async function signInWithPasskey(t: T, credential: TestCredential) {
  const start = await t.mutation(ref("mutation", "startSignInWithPasskey"), {});
  return await t.mutation(
    ref("mutation", "finishSignInWithPasskey"),
    await assertWith(credential, start.options.challenge),
  );
}

async function listPasskeys(t: T, tokens: TokenBundle) {
  const list = await as(t, tokens).query(ref("query", "listPasskeys"), {});
  if (!list.success) throw new Error("The caller is signed in.");
  return list.passkeys as { passkeyId: string; credentialId: string }[];
}

describe("signing in with a passkey", () => {
  test("signs in the owner of the passkey without a username", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const { credential } = await addPasskey(t, ada);

    const start = await t.mutation(
      ref("mutation", "startSignInWithPasskey"),
      {},
    );
    // A discoverable sign-in: the browser lists the passkeys it holds for
    // the relying party, and the one the user picks names the account.
    expect(start.options.rpId).toBe(RP_ID);
    expect(start.options.allowCredentials).toEqual([]);

    const result = await t.mutation(
      ref("mutation", "finishSignInWithPasskey"),
      await assertWith(credential, start.options.challenge),
    );
    expect(result).toEqual({
      status: "complete",
      tokens: expect.objectContaining({ userId: "ada" }),
    });
    // A new session, distinct from the one of the sign-up.
    expect(sessionIdentity(result.tokens).subject).not.toBe(
      sessionIdentity(ada).subject,
    );
  });

  test("refuses a passkey that the app does not know", async () => {
    const t = setup();
    const credential = await generateES256Credential();
    expect(await signInWithPasskey(t, credential)).toEqual({
      status: "error",
      userError: { error: "UNKNOWN_CREDENTIAL" },
    });
  });

  test("refuses to redeem a challenge twice", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const { credential } = await addPasskey(t, ada);
    const start = await t.mutation(
      ref("mutation", "startSignInWithPasskey"),
      {},
    );
    const assertion = await assertWith(credential, start.options.challenge);
    await t.mutation(ref("mutation", "finishSignInWithPasskey"), assertion);
    expect(
      await t.mutation(ref("mutation", "finishSignInWithPasskey"), assertion),
    ).toEqual({ status: "error", userError: { error: "CHALLENGE_EXPIRED" } });
  });
});

describe("adding a passkey", () => {
  test("names the passkey with the getUserName query of the app", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const start = await as(t, ada).mutation(
      ref("mutation", "startAddPasskey"),
      {},
    );
    if (!start.success) throw new Error("The caller is signed in.");
    expect(start.options.rp).toEqual({ id: RP_ID, name: "Test app" });
    expect(start.options.user.name).toBe("ada@example.com");
    expect(start.options.user.displayName).toBe("User ada");
    expect(start.options.excludeCredentials).toEqual([]);
  });

  test("excludes the passkeys that the user already holds", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const { credential } = await addPasskey(t, ada);
    const start = await as(t, ada).mutation(
      ref("mutation", "startAddPasskey"),
      {},
    );
    if (!start.success) throw new Error("The caller is signed in.");
    expect(start.options.excludeCredentials).toEqual([
      expect.objectContaining({ id: toBase64URL(credential.credentialId) }),
    ]);
  });

  test("fails loudly when the app gives no name", async () => {
    const t = setup();
    const nameless = await signUp(t, "nameless");
    await expect(
      as(t, nameless).mutation(ref("mutation", "startAddPasskey"), {}),
    ).rejects.toThrow("must return a non-empty `name` and `displayName`");
  });

  test("refuses a signed-out caller", async () => {
    const t = setup();
    expect(await t.mutation(ref("mutation", "startAddPasskey"), {})).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
  });

  test("needs a recent authentication", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    vi.setSystemTime(START + MAX_AGE_SECONDS * 1000 + MINUTE);
    expect(
      await as(t, ada).mutation(ref("mutation", "startAddPasskey"), {}),
    ).toEqual({
      success: false,
      userError: { error: "REAUTHENTICATION_REQUIRED" },
    });
  });

  test("checks the authentication time again when it finishes", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    vi.setSystemTime(START + 9 * MINUTE);
    const start = await as(t, ada).mutation(
      ref("mutation", "startAddPasskey"),
      {},
    );
    if (!start.success) throw new Error("The sign-in is recent.");

    vi.setSystemTime(START + 11 * MINUTE);
    const credential = await generateES256Credential();
    expect(
      await as(t, ada).mutation(
        ref("mutation", "finishAddPasskey"),
        await attest(start.options.challenge, credential),
      ),
    ).toEqual({
      success: false,
      userError: { error: "REAUTHENTICATION_REQUIRED" },
    });
    expect(await listPasskeys(t, ada)).toEqual([]);
  });

  test("accepts a re-authentication with a passkey", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const { credential } = await addPasskey(t, ada);
    vi.setSystemTime(START + 60 * MINUTE);

    const caller = as(t, ada);
    const start = await caller.mutation(
      ref("mutation", "startPasskeyReauthentication"),
      {},
    );
    if (!start.success) throw new Error("The user has a passkey.");
    expect(
      await caller.mutation(
        ref("mutation", "finishPasskeyReauthentication"),
        await assertWith(credential, start.options.challenge),
      ),
    ).toEqual({ success: true, authenticatedAt: expect.any(Number) });
    expect(await caller.query(ref("query", "authenticationTime"), {})).toEqual({
      authenticatedAt: expect.closeTo(START + 60 * MINUTE + 4.5, -1),
      component: "authPasskey",
    });

    await addPasskey(t, ada);
    expect(await listPasskeys(t, ada)).toHaveLength(2);
  });
});

describe("removing a passkey", () => {
  test("adds, lists and removes a passkey", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const { passkeyId, credential } = await addPasskey(t, ada);
    expect(await listPasskeys(t, ada)).toEqual([
      expect.objectContaining({
        passkeyId,
        credentialId: toBase64URL(credential.credentialId),
      }),
    ]);

    // The last passkey can go: the user signs in with their email.
    expect(
      await as(t, ada).mutation(ref("mutation", "removePasskey"), {
        passkeyId,
      }),
    ).toEqual({ success: true });
    expect(await listPasskeys(t, ada)).toEqual([]);
    expect(await signInWithPasskey(t, credential)).toEqual({
      status: "error",
      userError: { error: "UNKNOWN_CREDENTIAL" },
    });
  });

  test("refuses a passkey of another user", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const bob = await signUp(t, "bob");
    const { passkeyId } = await addPasskey(t, ada);
    expect(
      await as(t, bob).mutation(ref("mutation", "removePasskey"), {
        passkeyId,
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });
    expect(await listPasskeys(t, ada)).toHaveLength(1);
  });

  test("needs a recent authentication", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const { passkeyId } = await addPasskey(t, ada);
    vi.setSystemTime(START + MAX_AGE_SECONDS * 1000 + MINUTE);
    expect(
      await as(t, ada).mutation(ref("mutation", "removePasskey"), {
        passkeyId,
      }),
    ).toEqual({
      success: false,
      userError: { error: "REAUTHENTICATION_REQUIRED" },
    });
  });

  test("refuses a signed-out caller", async () => {
    const t = setup();
    expect(
      await t.mutation(ref("mutation", "removePasskey"), { passkeyId: "x" }),
    ).toEqual({ success: false, userError: { error: "NOT_LOGGED_IN" } });
  });
});

describe("re-authenticating with a passkey", () => {
  test("refuses a passkey of another user", async () => {
    const t = setup();
    const ada = await signUp(t, "ada");
    const bob = await signUp(t, "bob");
    await addPasskey(t, ada);
    const { credential: bobsCredential } = await addPasskey(t, bob);

    const start = await as(t, ada).mutation(
      ref("mutation", "startPasskeyReauthentication"),
      {},
    );
    if (!start.success) throw new Error("The user has a passkey.");
    expect(
      await as(t, ada).mutation(
        ref("mutation", "finishPasskeyReauthentication"),
        await assertWith(bobsCredential, start.options.challenge),
      ),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });
  });
});

describe("setupPasskey", () => {
  test("refuses a negative maxAuthenticationAgeSeconds", () => {
    expect(() =>
      setupPasskey(core, {
        component: components.authPasskey,
        rpId: RP_ID,
        origin: ORIGIN,
        maxAuthenticationAgeSeconds: -1,
      }),
    ).toThrow("`maxAuthenticationAgeSeconds` must be a finite number");
  });
});
