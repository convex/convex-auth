/**
 * The re-authentication functions of `auth.ts`: a signed-in user proves who
 * they are again with a passkey, and the current session records the time.
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import { registerPasskey } from "@convex-dev/auth/components/passkey/test";
import { registerUsername } from "@convex-dev/auth/components/username/test";
// The software authenticator is a private package of this repository. See
// `passkeyManagement.test.ts`.
import {
  buildAssertion,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  registrationResponse,
  type TestCredential,
} from "@convex-dev/passkey-test-authenticator";
import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// The relying party of `auth.ts`.
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

const START = new Date("2026-01-01T00:00:00Z").getTime();

type T = TestConvex<typeof schema>;

type Tokens = { accessToken: string };

type User = { userId: string; tokens: Tokens; credential: TestCredential };

function setup(): T {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerUsername(t);
  registerPasskey(t);
  return t;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const as = (t: T, tokens: Tokens) => t.withIdentity(sessionIdentity(tokens));

const assertWith = (credential: TestCredential, challenge: string) =>
  buildAssertion(credential, challenge, { rpId: RP_ID, origin: ORIGIN });

/** Register a new account with its first passkey. */
async function signUp(t: T, username: string): Promise<User> {
  const start = await t.mutation(api.auth.startSignInWithUsernamePasskey, {
    username,
  });
  if (!start.success || start.step !== "register") {
    throw new Error("The username is not free.");
  }
  const credential = await generateES256Credential();
  const authenticatorData = await buildAuthenticatorData({
    rpId: RP_ID,
    credential,
  });
  const result = await t.mutation(api.auth.finishSignUpWithUsernamePasskey, {
    username,
    response: registrationResponse({
      credential,
      attestationObject: buildAttestationObject(authenticatorData),
      clientDataJSON: buildClientDataJSON({
        type: "webauthn.create",
        challenge: start.options.challenge,
        origin: ORIGIN,
      }),
    }),
  });
  if (result.status !== "complete") {
    throw new Error(`The sign-up failed: ${result.userError.error}`);
  }
  return { userId: result.tokens.userId, tokens: result.tokens, credential };
}

/** Sign an existing account in again, which makes a second session. */
async function signIn(t: T, username: string, credential: TestCredential) {
  const start = await t.mutation(api.auth.startSignInWithUsernamePasskey, {
    username,
  });
  if (!start.success || start.step !== "authenticate") {
    throw new Error("The username has no account.");
  }
  const result = await t.mutation(
    api.auth.finishSignInWithUsernamePasskey,
    await assertWith(credential, start.options.challenge),
  );
  if (result.status !== "complete") {
    throw new Error(`The sign-in failed: ${result.userError.error}`);
  }
  return result.tokens;
}

/** Run the whole re-authentication flow with `credential`. */
async function reauthenticate(
  t: T,
  tokens: Tokens,
  credential: TestCredential,
) {
  const caller = as(t, tokens);
  const start = await caller.mutation(
    api.auth.startPasskeyReauthentication,
    {},
  );
  if (!start.success) {
    throw new Error(`The re-authentication could not start.`);
  }
  return await caller.mutation(
    api.auth.finishPasskeyReauthentication,
    await assertWith(credential, start.options.challenge),
  );
}

/** When the session of `tokens` last authenticated, as the core reports it. */
async function authenticatedAt(t: T, tokens: Tokens) {
  const { subject } = sessionIdentity(tokens);
  const result = await t.run((ctx) =>
    ctx.runQuery(components.auth.public.getAuthenticationTime, {
      sessionId: subject,
    }),
  );
  return result?.authentication?.authenticatedAt ?? null;
}

// convex-test keeps each `_creationTime` above the previous one, thus a
// recorded time can be a few milliseconds past the clock. Accept a time from
// `time` up to 9 ms later.
const at = (time: number) => expect.closeTo(time + 4.5, -1);

describe("startPasskeyReauthentication", () => {
  test("offers the passkeys of the caller", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const start = await as(t, alice.tokens).mutation(
      api.auth.startPasskeyReauthentication,
      {},
    );
    if (!start.success) throw new Error("The caller is signed in.");
    expect(start.options.rpId).toBe(RP_ID);
    expect(start.options.allowCredentials).toHaveLength(1);
  });

  test("refuses a signed-out caller", async () => {
    const t = setup();
    expect(await t.mutation(api.auth.startPasskeyReauthentication, {})).toEqual(
      { success: false, userError: { error: "NOT_LOGGED_IN" } },
    );
  });

  test("refuses a user without a passkey", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const list = await as(t, alice.tokens).query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    await t.run((ctx) =>
      ctx.runMutation(components.authPasskey.registration.deletePasskey, {
        userId: alice.userId,
        passkeyId: list.passkeys[0].passkeyId,
      }),
    );
    expect(
      await as(t, alice.tokens).mutation(
        api.auth.startPasskeyReauthentication,
        {},
      ),
    ).toEqual({ success: false, userError: { error: "NO_PASSKEY" } });
  });
});

describe("finishPasskeyReauthentication", () => {
  test("moves the authentication time of the session forward", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    expect(await authenticatedAt(t, alice.tokens)).toEqual(at(START));

    vi.setSystemTime(START + 60 * 60 * 1000);
    const result = await reauthenticate(t, alice.tokens, alice.credential);
    expect(result).toEqual({
      success: true,
      authenticatedAt: at(START + 60 * 60 * 1000),
    });
    expect(await authenticatedAt(t, alice.tokens)).toEqual(
      at(START + 60 * 60 * 1000),
    );
  });

  test("refuses a passkey of another user", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const bob = await signUp(t, "bob");

    vi.setSystemTime(START + 60 * 60 * 1000);
    // The challenge lists Alice's passkeys only, and is bound to her.
    // Bob's passkey cannot answer it.
    const result = await reauthenticate(t, alice.tokens, bob.credential);
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    expect(await authenticatedAt(t, alice.tokens)).toEqual(at(START));
  });

  test("refuses an assertion that was minted for a sign-in", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const start = await t.mutation(api.auth.startSignInWithUsernamePasskey, {
      username: "alice",
    });
    if (!start.success || start.step !== "authenticate") {
      throw new Error("The username has an account.");
    }
    expect(
      await as(t, alice.tokens).mutation(
        api.auth.finishPasskeyReauthentication,
        await assertWith(alice.credential, start.options.challenge),
      ),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });
  });

  test("refuses to redeem a challenge twice", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice.tokens);
    const start = await caller.mutation(
      api.auth.startPasskeyReauthentication,
      {},
    );
    if (!start.success) throw new Error("The caller is signed in.");
    const assertion = await assertWith(
      alice.credential,
      start.options.challenge,
    );
    expect(
      await caller.mutation(api.auth.finishPasskeyReauthentication, assertion),
    ).toMatchObject({ success: true });
    expect(
      await caller.mutation(api.auth.finishPasskeyReauthentication, assertion),
    ).toEqual({ success: false, userError: { error: "CHALLENGE_EXPIRED" } });
  });

  test("refuses a signed-out caller", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    const start = await as(t, alice.tokens).mutation(
      api.auth.startPasskeyReauthentication,
      {},
    );
    if (!start.success) throw new Error("The caller is signed in.");
    expect(
      await t.mutation(
        api.auth.finishPasskeyReauthentication,
        await assertWith(alice.credential, start.options.challenge),
      ),
    ).toEqual({ success: false, userError: { error: "NOT_LOGGED_IN" } });
  });

  test("leaves the other sessions of the user alone", async () => {
    const t = setup();
    const alice = await signUp(t, "alice");
    vi.setSystemTime(START + 60 * 1000);
    const laptop = await signIn(t, "alice", alice.credential);

    vi.setSystemTime(START + 60 * 60 * 1000);
    await reauthenticate(t, alice.tokens, alice.credential);

    expect(await authenticatedAt(t, alice.tokens)).toEqual(
      at(START + 60 * 60 * 1000),
    );
    expect(await authenticatedAt(t, laptop)).toEqual(at(START + 60 * 1000));
  });
});
