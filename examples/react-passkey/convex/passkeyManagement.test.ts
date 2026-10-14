/**
 * The passkey-management functions of `auth.ts`, driven the way the app
 * drives them: a signed-in user lists, adds, and removes their passkeys.
 *
 * The test runs against this example app, thus it covers the wiring that a
 * real app copies — the `setupUsernamePasskey` call, the `createUser`
 * callback, and the mount paths of `convex.config.ts`.
 */
import { convexTest, type TestConvex } from "convex-test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import { registerPasskeyProvider } from "@convex-dev/auth/components/passkey/test";
// The software authenticator is a private package of this repository, not a
// part of the public API of `@convex-dev/auth`. An app writes an authenticator
// of its own, or it drives a real one.
import {
  aaguidBytes,
  buildAssertion,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  registrationResponse,
  toBase64URL,
  type TestCredential,
} from "@convex-dev/passkey-test-authenticator";
import { registerUsername } from "@convex-dev/auth/components/username/test";
import { api, components } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// The limit that the passkey component applies to one user. The component
// does not export it, so the test keeps a copy.
const MAX_PASSKEYS_PER_USER = 20;

// The relying party of `auth.ts`. The software authenticator has its own
// defaults, thus every ceremony below names these.
const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

type T = TestConvex<typeof schema>;

async function setup(): Promise<T> {
  // The core signs JWTs from these env vars. Mint a real RS256 key pair for
  // each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(await exportPKCS8(privateKey)));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerUsername(t);
  registerPasskeyProvider(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A signed-up user, with the session of their sign-up. */
type User = {
  userId: string;
  tokens: { accessToken: string };
  credential: TestCredential;
};

/** The caller as a signed-in user, the way a real access token identifies one. */
const as = (t: T, user: Pick<User, "tokens">) =>
  t.withIdentity(sessionIdentity(user.tokens));

/**
 * Build the `response` of a `create()` ceremony, spreadable into args.
 *
 * `aaguid` is the authenticator model that the attestation reports. It is
 * zeroed by default, like an authenticator that hides its model.
 */
async function attest(
  challenge: string,
  credential: TestCredential,
  aaguid?: Uint8Array,
): Promise<{ response: ReturnType<typeof registrationResponse> }> {
  const authenticatorData = await buildAuthenticatorData({
    rpId: RP_ID,
    credential,
    aaguid,
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

/** Build the `response` of a `get()` ceremony, spreadable into args. */
const assertWith = (credential: TestCredential, challenge: string) =>
  buildAssertion(credential, challenge, { rpId: RP_ID, origin: ORIGIN });

/** Register a new account with its first passkey. */
async function signUp(
  t: T,
  username: string,
  aaguid?: Uint8Array,
): Promise<User> {
  const start = await t.mutation(api.auth.startSignInWithUsernamePasskey, {
    username,
  });
  if (!start.success || start.step !== "register") {
    throw new Error("The username is not free.");
  }
  const credential = await generateES256Credential();
  const result = await t.mutation(api.auth.finishSignUpWithUsernamePasskey, {
    username,
    ...(await attest(start.options.challenge, credential, aaguid)),
  });
  if (result.status !== "complete") {
    throw new Error(`The sign-up failed: ${result.userError.error}`);
  }
  return { userId: result.tokens.userId, tokens: result.tokens, credential };
}

/** Run the full add flow and return the new passkey. */
async function addPasskey(
  t: T,
  user: Pick<User, "tokens">,
  authorizeWith: TestCredential,
  aaguid?: Uint8Array,
): Promise<{ passkeyId: string; credential: TestCredential }> {
  const caller = as(t, user);
  const start = await caller.mutation(api.auth.startAddPasskey, {});
  if (!start.success) {
    throw new Error(`The add could not start: ${start.userError.error}`);
  }
  const verified = await caller.mutation(
    api.auth.verifyAddPasskey,
    await assertWith(authorizeWith, start.options.challenge),
  );
  if (!verified.success) {
    throw new Error(
      `The re-authentication failed: ${verified.userError.error}`,
    );
  }
  const credential = await generateES256Credential();
  const finished = await caller.mutation(
    api.auth.finishAddPasskey,
    await attest(verified.options.challenge, credential, aaguid),
  );
  if (!finished.success) {
    throw new Error(`The add failed: ${finished.userError.error}`);
  }
  return { passkeyId: finished.passkeyId, credential };
}

describe("listPasskeys", () => {
  test("returns the passkeys of the caller only", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const bob = await signUp(t, "bob");
    await addPasskey(t, alice, alice.credential);

    const forAlice = await as(t, alice).query(api.auth.listPasskeys, {});
    const forBob = await as(t, bob).query(api.auth.listPasskeys, {});
    if (!forAlice.success || !forBob.success) {
      throw new Error("The caller is signed in.");
    }
    expect(forAlice.passkeys).toHaveLength(2);
    expect(forBob.passkeys).toHaveLength(1);
    expect(forAlice.passkeys[0]).toEqual({
      passkeyId: expect.any(String),
      credentialId: expect.any(String),
      createdAt: expect.any(Number),
    });
    expect(forBob.passkeys[0].credentialId).toBe(
      toBase64URL(bob.credential.credentialId),
    );
  });

  test("refuses a signed-out caller", async () => {
    const t = await setup();
    await signUp(t, "alice");
    expect(await t.query(api.auth.listPasskeys, {})).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
  });
});

describe("default passkey names", () => {
  const APPLE_PASSWORDS = aaguidBytes("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");

  /** The names of the passkeys of `user`, in the order of the list. */
  async function names(
    t: T,
    user: Pick<User, "tokens">,
  ): Promise<(string | undefined)[]> {
    const list = await as(t, user).query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    return list.passkeys.map((passkey) => passkey.name);
  }

  test("names the passkey of a sign-up after its authenticator", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice", APPLE_PASSWORDS);
    expect(await names(t, alice)).toEqual(["Apple Passwords"]);
  });

  test("names an added passkey after its authenticator", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    await addPasskey(t, alice, alice.credential, APPLE_PASSWORDS);
    expect(await names(t, alice)).toEqual([undefined, "Apple Passwords"]);
  });

  test("stores no name for an authenticator that reports no model", async () => {
    // `attestation: "none"` lets an authenticator zero its AAGUID; the big
    // passkey providers report theirs anyway.
    const t = await setup();
    const alice = await signUp(t, "alice");
    await addPasskey(t, alice, alice.credential);
    expect(await names(t, alice)).toEqual([undefined, undefined]);
  });
});

describe("adding a passkey", () => {
  test("adds a second passkey through the whole flow", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice);

    const start = await caller.mutation(api.auth.startAddPasskey, {});
    if (!start.success) throw new Error("The caller is signed in.");
    expect(start.options.rpId).toBe(RP_ID);
    // Each passkey of the account can authorize the add.
    expect(start.options.allowCredentials).toHaveLength(1);
    expect(start.options.allowCredentials[0].id).toBe(
      toBase64URL(alice.credential.credentialId),
    );

    const verified = await caller.mutation(
      api.auth.verifyAddPasskey,
      await assertWith(alice.credential, start.options.challenge),
    );
    if (!verified.success) throw new Error("The assertion is valid.");
    expect(verified.options.rp.id).toBe(RP_ID);
    // `auth.ts` names no `rpName`, thus the relying party ID stands in for it.
    expect(verified.options.rp.name).toBe(RP_ID);
    expect(verified.options.user.name).toBe("alice");
    expect(verified.options.user.displayName).toBe("alice");
    // The authenticator must not make a second credential for a passkey the
    // account already holds.
    expect(verified.options.excludeCredentials).toHaveLength(1);
    expect(verified.options.excludeCredentials[0].id).toBe(
      toBase64URL(alice.credential.credentialId),
    );

    const credential = await generateES256Credential();
    const finished = await caller.mutation(
      api.auth.finishAddPasskey,
      await attest(verified.options.challenge, credential),
    );
    expect(finished).toEqual({ success: true, passkeyId: expect.any(String) });

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys).toHaveLength(2);
  });

  test("refuses an assertion that was minted for another flow", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice);

    // A sign-in challenge carries a different purpose.
    const start = await t.mutation(api.auth.startSignInWithUsernamePasskey, {
      username: "alice",
    });
    if (!start.success || start.step !== "authenticate") {
      throw new Error("The username has an account.");
    }
    // A purpose that does not match is a protocol violation: the message
    // goes to the backend logs, and the client gets `PROTOCOL_ERROR`.
    expect(
      await caller.mutation(
        api.auth.verifyAddPasskey,
        await assertWith(alice.credential, start.options.challenge),
      ),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });
  });

  test("refuses to name a passkey for a user without a username", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    await t.run((ctx) =>
      ctx.runMutation(components.authUsername.public.deleteUsername, {
        userId: alice.userId,
      }),
    );
    const caller = as(t, alice);

    const start = await caller.mutation(api.auth.startAddPasskey, {});
    if (!start.success) throw new Error("The caller is signed in.");
    // The re-authentication succeeds, but the server cannot build the
    // `user.name` for the new passkey. Only the app can remove a username,
    // so the failure is an error for the developer, not a `userError`.
    await expect(
      caller.mutation(
        api.auth.verifyAddPasskey,
        await assertWith(alice.credential, start.options.challenge),
      ),
    ).rejects.toThrow("no username");
  });

  test("refuses a create() ceremony that no verifyAddPasskey started", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const credential = await generateES256Credential();

    // No registration challenge exists at all.
    expect(
      await as(t, alice).mutation(
        api.auth.finishAddPasskey,
        await attest(toBase64URL(new ArrayBuffer(32)), credential),
      ),
    ).toEqual({ success: false, userError: { error: "CHALLENGE_EXPIRED" } });
  });

  test("refuses a registration challenge that the sign-up flow minted", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");

    // The sign-up branch mints a challenge with no user, thus it belongs to
    // the new-user flow. `finishAddPasskey` runs the existing-user flow, and
    // the flows never mix: the mismatch is a protocol violation, the message
    // goes to the backend logs, and the client gets `PROTOCOL_ERROR`.
    const start = await t.mutation(api.auth.startSignInWithUsernamePasskey, {
      username: "carol",
    });
    if (!start.success || start.step !== "register") {
      throw new Error("The username is free.");
    }
    const credential = await generateES256Credential();
    expect(
      await as(t, alice).mutation(
        api.auth.finishAddPasskey,
        await attest(start.options.challenge, credential),
      ),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });
  });

  test("refuses a user who already holds the largest number of passkeys", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice);

    // The sign-up made the first passkey; fill the remaining places.
    for (let i = 1; i < MAX_PASSKEYS_PER_USER; i++) {
      await addPasskey(t, alice, alice.credential);
    }
    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys).toHaveLength(MAX_PASSKEYS_PER_USER);

    expect(await caller.mutation(api.auth.startAddPasskey, {})).toEqual({
      success: false,
      userError: { error: "TOO_MANY_PASSKEYS" },
    });
  });

  test("refuses a ceremony whose last place a second tab took", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice);
    for (let i = 2; i < MAX_PASSKEYS_PER_USER; i++) {
      await addPasskey(t, alice, alice.credential);
    }

    // One place is left: this ceremony starts and gets its challenge.
    const start = await caller.mutation(api.auth.startAddPasskey, {});
    if (!start.success) throw new Error("One place is left.");
    const verified = await caller.mutation(
      api.auth.verifyAddPasskey,
      await assertWith(alice.credential, start.options.challenge),
    );
    if (!verified.success) throw new Error("The assertion is valid.");

    // A second tab takes the last place before this ceremony finishes.
    await addPasskey(t, alice, alice.credential);

    expect(
      await caller.mutation(
        api.auth.finishAddPasskey,
        await attest(
          verified.options.challenge,
          await generateES256Credential(),
        ),
      ),
    ).toEqual({ success: false, userError: { error: "TOO_MANY_PASSKEYS" } });
  });

  test("refuses a signed-out caller", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const notSignedIn = {
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    };

    expect(await t.mutation(api.auth.startAddPasskey, {})).toEqual(notSignedIn);
    expect(
      await t.mutation(
        api.auth.verifyAddPasskey,
        await assertWith(alice.credential, toBase64URL(new ArrayBuffer(32))),
      ),
    ).toEqual(notSignedIn);
    expect(
      await t.mutation(
        api.auth.finishAddPasskey,
        await attest(
          toBase64URL(new ArrayBuffer(32)),
          await generateES256Credential(),
        ),
      ),
    ).toEqual(notSignedIn);
  });
});

describe("renaming a passkey", () => {
  test("renames a passkey of the caller and refuses bad input", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const caller = as(t, alice);
    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    const { passkeyId } = list.passkeys[0];

    expect(
      await caller.mutation(api.auth.renamePasskey, {
        passkeyId,
        name: "My security key",
      }),
    ).toEqual({ success: true });
    const after = await caller.query(api.auth.listPasskeys, {});
    if (!after.success) throw new Error("The caller is signed in.");
    expect(after.passkeys[0].name).toBe("My security key");

    expect(
      await caller.mutation(api.auth.renamePasskey, { passkeyId, name: "" }),
    ).toEqual({ success: false, userError: { error: "INVALID_NAME" } });
  });

  test("refuses a passkey of another account and a signed-out caller", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const bob = await signUp(t, "bob");
    const bobList = await as(t, bob).query(api.auth.listPasskeys, {});
    if (!bobList.success) throw new Error("The caller is signed in.");
    const { passkeyId } = bobList.passkeys[0];

    expect(
      await as(t, alice).mutation(api.auth.renamePasskey, {
        passkeyId,
        name: "Not mine",
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });
    expect(
      await t.mutation(api.auth.renamePasskey, { passkeyId, name: "Mine" }),
    ).toEqual({ success: false, userError: { error: "NOT_SIGNED_IN" } });
  });
});

describe("removing a passkey", () => {
  test("removes a passkey through the whole flow", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice, alice.credential);
    const caller = as(t, alice);

    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    expect(start.options.rpId).toBe(RP_ID);
    // The passkey that goes away cannot authorize its own removal, thus the
    // browser must not offer it.
    expect(start.options.allowCredentials).toHaveLength(1);
    expect(start.options.allowCredentials[0].id).toBe(
      toBase64URL(alice.credential.credentialId),
    );

    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: second.passkeyId,
        ...(await assertWith(alice.credential, start.options.challenge)),
      }),
    ).toEqual({ success: true });

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0].credentialId).toBe(
      toBase64URL(alice.credential.credentialId),
    );
  });

  test("refuses to remove the only passkey of the account", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const list = await as(t, alice).query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");

    expect(
      await as(t, alice).mutation(api.auth.startRemovePasskey, {
        passkeyId: list.passkeys[0].passkeyId,
      }),
    ).toEqual({ success: false, userError: { error: "LAST_PASSKEY" } });
  });

  test("refuses an assertion from the passkey that goes away", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice, alice.credential);
    const caller = as(t, alice);

    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");

    // The start step keeps the target out of `allowCredentials`, thus a
    // client that respects the protocol never sends this assertion. The
    // finish step is what enforces the rule.
    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: second.passkeyId,
        ...(await assertWith(second.credential, start.options.challenge)),
      }),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    expect(list.passkeys.map((passkey) => passkey.passkeyId)).toContain(
      second.passkeyId,
    );
  });

  test("refuses a `passkeyId` that the start step did not get", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice, alice.credential);
    const caller = as(t, alice);

    // The app starts the removal of the second passkey, thus the user
    // answers the dialog with the first one.
    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    const assertion = await assertWith(
      alice.credential,
      start.options.challenge,
    );

    const list = await caller.query(api.auth.listPasskeys, {});
    if (!list.success) throw new Error("The caller is signed in.");
    const first = list.passkeys.find(
      (passkey) => passkey.passkeyId !== second.passkeyId,
    );
    if (first === undefined) throw new Error("The account has two passkeys.");

    // The app then sends a different `passkeyId` than the one that made the
    // challenge, and that `passkeyId` is the passkey that signed. No correct
    // caller does this, thus the result is a `PROTOCOL_ERROR`.
    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: first.passkeyId,
        ...assertion,
      }),
    ).toEqual({ success: false, userError: { error: "PROTOCOL_ERROR" } });

    const after = await caller.query(api.auth.listPasskeys, {});
    if (!after.success) throw new Error("The caller is signed in.");
    expect(after.passkeys).toHaveLength(2);
  });

  test("refuses a passkey of another account", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    await addPasskey(t, alice, alice.credential);
    const bob = await signUp(t, "bob");
    const bobList = await as(t, bob).query(api.auth.listPasskeys, {});
    if (!bobList.success) throw new Error("The caller is signed in.");

    expect(
      await as(t, alice).mutation(api.auth.startRemovePasskey, {
        passkeyId: bobList.passkeys[0].passkeyId,
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });
  });

  test("refuses a passkey of another account at the finish step", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice, alice.credential);
    const bob = await signUp(t, "bob");
    const bobList = await as(t, bob).query(api.auth.listPasskeys, {});
    if (!bobList.success) throw new Error("The caller is signed in.");
    const caller = as(t, alice);

    // A valid challenge of the caller carries no target, thus the finish
    // step must check the ownership itself.
    const start = await caller.mutation(api.auth.startRemovePasskey, {
      passkeyId: second.passkeyId,
    });
    if (!start.success) throw new Error("The account has two passkeys.");
    expect(
      await caller.mutation(api.auth.finishRemovePasskey, {
        passkeyId: bobList.passkeys[0].passkeyId,
        ...(await assertWith(alice.credential, start.options.challenge)),
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });

    const stillThere = await as(t, bob).query(api.auth.listPasskeys, {});
    if (!stillThere.success) throw new Error("The caller is signed in.");
    expect(stillThere.passkeys).toHaveLength(1);
  });

  test("refuses a signed-out caller", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice");
    const second = await addPasskey(t, alice, alice.credential);
    const notSignedIn = {
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    };

    expect(
      await t.mutation(api.auth.startRemovePasskey, {
        passkeyId: second.passkeyId,
      }),
    ).toEqual(notSignedIn);
    expect(
      await t.mutation(api.auth.finishRemovePasskey, {
        passkeyId: second.passkeyId,
        ...(await assertWith(
          alice.credential,
          toBase64URL(new ArrayBuffer(32)),
        )),
      }),
    ).toEqual(notSignedIn);
  });
});
