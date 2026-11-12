import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import { toArrayBuffer } from "./helpers.ts";
import { MAX_PASSKEY_NAME_LENGTH } from "./validation.ts";
import { CHALLENGE_TTL_MS } from "./constants.ts";
import {
  ORIGIN,
  RP_ID,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  encodeCBOR,
  generateES256Credential,
  generateRS256Credential,
  registrationResponse,
  toBase64URL,
} from "@convex-dev/passkey-test-authenticator";
import {
  expectProtocolError,
  expectSameBytes,
  register,
  setup,
} from "../passkeyTestSetup.ts";

const ANDROID_ORIGIN =
  "android:apk-key-hash:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

function handleRows(t: ReturnType<typeof setup>) {
  return t.run((ctx) => ctx.db.query("handles").collect());
}

/**
 * Make the one challenge in flight expire. The age of a challenge is the age
 * of its `_creationTime`, thus the clock is the only way to make it expire.
 */
function expireChallenge() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + CHALLENGE_TTL_MS + 1000);
}

/**
 * Make every new handle the same bytes, and return a function that restores
 * the real randomness. Only the 64-byte values are handles: the challenges
 * (32 bytes) stay random.
 */
function collideHandles() {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  const spy = vi
    .spyOn(crypto, "getRandomValues")
    .mockImplementation((array) =>
      array !== null && array.byteLength === 64
        ? (array as Uint8Array<ArrayBuffer>).fill(7)
        : getRandomValues(array as Uint8Array<ArrayBuffer>),
    );
  return () => spy.mockRestore();
}

/**
 * Build valid finish arguments, with overridable pieces.
 *
 * `options.startUserId` says which start function runs: a string starts the
 * existing-user flow for that user, and `null` starts the new-user flow. It
 * is `userId` by default.
 *
 * The returned `finish` calls the finish function of the flow that started
 * the ceremony, with `userId` as the user. A test that finishes in the other
 * flow calls the mutation by itself.
 */
async function registrationArgs(
  t: ReturnType<typeof setup>,
  userId: string,
  options: {
    credential?: Awaited<ReturnType<typeof generateES256Credential>>;
    name?: string;
    counter?: number;
    origin?: string;
    expectedOrigin?: string | string[];
    crossOrigin?: boolean;
    clientDataType?: "webauthn.create" | "webauthn.get";
    authDataRpId?: string;
    userPresent?: boolean;
    userVerified?: boolean;
    includeCredential?: boolean;
    challenge?: ArrayBuffer;
    startUserId?: string | null;
  } = {},
) {
  const credential = options.credential ?? (await generateES256Credential());
  const startUserId =
    options.startUserId !== undefined ? options.startUserId : userId;
  let challenge: ArrayBuffer;
  let userHandle: ArrayBuffer | null;
  if (options.challenge !== undefined) {
    // A supplied challenge stands in for a ceremony that the component does
    // not know, thus no ceremony starts in that case.
    challenge = options.challenge;
    userHandle = null;
  } else {
    const started =
      startUserId === null
        ? await t.mutation(api.registration.startRegistrationForNewUser, {})
        : await t.mutation(api.registration.startRegistrationForExistingUser, {
            verifiedUserId: startUserId,
          });
    challenge = started.challenge;
    userHandle = started.userHandle;
  }
  const authData = await buildAuthenticatorData({
    rpId: options.authDataRpId ?? RP_ID,
    counter: options.counter ?? 0,
    userPresent: options.userPresent,
    userVerified: options.userVerified,
    credential: options.includeCredential === false ? undefined : credential,
  });
  const buildArgs = (extra: { transports?: string[] } = {}) => ({
    expectedRpId: RP_ID,
    expectedOrigin: options.expectedOrigin ?? ORIGIN,
    name: options.name,
    response: registrationResponse({
      credential,
      attestationObject: buildAttestationObject(authData),
      clientDataJSON: buildClientDataJSON({
        type: options.clientDataType ?? "webauthn.create",
        challenge,
        origin: options.origin ?? ORIGIN,
        crossOrigin: options.crossOrigin,
      }),
      transports: extra.transports,
    }),
  });
  const args = buildArgs();
  const finish = (extra: { transports?: string[] } = {}) =>
    startUserId === null
      ? t.mutation(
          api.registration._internal_dangerous_finishRegistrationForNewUser,
          {
            ...buildArgs(extra),
            newUserId: userId,
          },
        )
      : t.mutation(
          api.registration
            ._internal_dangerous_finishRegistrationForExistingUser,
          {
            ...buildArgs(extra),
            verifiedUserId: userId,
          },
        );
  return { credential, userHandle, args, finish };
}

// Only the expiry tests move the clock, but the restore is global to keep the
// other tests on the real clock.
afterEach(() => {
  vi.useRealTimers();
});

describe("startRegistrationForNewUser", () => {
  test("stores an anonymous registration row with a 32-byte challenge", async () => {
    const t = setup();
    const { challenge } = await t.mutation(
      api.registration.startRegistrationForNewUser,
      {},
    );
    expect(new Uint8Array(challenge).length).toBe(32);
    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("registration");
    expectSameBytes(rows[0].challenge, challenge);
    // Registration challenges carry no identity: they point at a handle.
    expect("userId" in rows[0]).toBe(false);
    const handles = await handleRows(t);
    expect(rows[0]).toMatchObject({ handleId: handles[0]._id });
  });

  test("makes an unlinked handle", async () => {
    const t = setup();
    const { userHandle } = await t.mutation(
      api.registration.startRegistrationForNewUser,
      {},
    );
    // 64 bytes is the WebAuthn maximum length for `user.id`.
    expect(new Uint8Array(userHandle).length).toBe(64);

    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe(null);
    expectSameBytes(handles[0].handle, userHandle);
  });

  test("does not reuse the unlinked handle of another ceremony", async () => {
    const t = setup();
    const first = await t.mutation(
      api.registration.startRegistrationForNewUser,
      {},
    );
    const second = await t.mutation(
      api.registration.startRegistrationForNewUser,
      {},
    );

    expect(new Uint8Array(second.userHandle)).not.toEqual(
      new Uint8Array(first.userHandle),
    );
    expect(await handleRows(t)).toHaveLength(2);
  });

  test("throws when a new handle collides with an existing handle", async () => {
    const t = setup();
    const restore = collideHandles();
    try {
      await t.mutation(api.registration.startRegistrationForNewUser, {});
      await expect(
        t.mutation(api.registration.startRegistrationForNewUser, {}),
      ).rejects.toThrow("collides with an existing handle");
    } finally {
      restore();
    }
    expect(await handleRows(t)).toHaveLength(1);
  });
});

describe("startRegistrationForExistingUser", () => {
  test("stores an anonymous registration row with a 32-byte challenge", async () => {
    const t = setup();
    const { challenge } = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    expect(new Uint8Array(challenge).length).toBe(32);
    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("registration");
    expectSameBytes(rows[0].challenge, challenge);
    // Registration challenges carry no identity, even when a userId is given:
    // they point at a handle instead.
    expect("userId" in rows[0]).toBe(false);
    const handles = await handleRows(t);
    expect(rows[0]).toMatchObject({ handleId: handles[0]._id });
  });

  test("makes a linked handle for a known user with no handle", async () => {
    const t = setup();
    const { userHandle } = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
    expectSameBytes(handles[0].handle, userHandle);
  });

  test("reuses the existing handle of a user", async () => {
    const t = setup();
    const first = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    const second = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );

    expectSameBytes(second.userHandle, first.userHandle);
    // Each user has a maximum of one handle.
    expect(await handleRows(t)).toHaveLength(1);
    // The challenges are distinct, and both point at the same handle.
    expect(new Uint8Array(second.challenge)).not.toEqual(
      new Uint8Array(first.challenge),
    );
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    const handleIds = new Set(
      challenges.map((row) =>
        row.kind === "registration" ? row.handleId : null,
      ),
    );
    expect(handleIds.size).toBe(1);
  });

  test("makes a separate handle for each user", async () => {
    const t = setup();
    const first = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    const second = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user2" },
    );

    expect(new Uint8Array(second.userHandle)).not.toEqual(
      new Uint8Array(first.userHandle),
    );
    expect(await handleRows(t)).toHaveLength(2);
  });

  test("does not reuse the unlinked handle of a new-user ceremony", async () => {
    const t = setup();
    const unlinked = await t.mutation(
      api.registration.startRegistrationForNewUser,
      {},
    );
    const started = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );

    expect(new Uint8Array(started.userHandle)).not.toEqual(
      new Uint8Array(unlinked.userHandle),
    );
    expect((await handleRows(t)).map((row) => row.userId)).toEqual([
      null,
      "user1",
    ]);
  });

  test("returns exactly the user's credential IDs as excludeCredentials", async () => {
    const t = setup();
    const first = await register(t, "user1");
    const second = await register(t, "user1");
    await register(t, "user2");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    const ids = excludeCredentials.map(({ id }) =>
      Array.from(new Uint8Array(id)).join(","),
    );
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first.credential.credentialId.join(","));
    expect(ids).toContain(second.credential.credentialId.join(","));
  });

  test("returns no excludeCredentials for a user with no passkey", async () => {
    const t = setup();
    await register(t, "user1");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user2" },
    );
    expect(excludeCredentials).toEqual([]);
  });

  test("returns the transports of each passkey in excludeCredentials", async () => {
    const t = setup();
    const stored = await register(t, "user1", { transports: ["usb", "nfc"] });
    const withoutTransports = await register(t, "user1");
    const { excludeCredentials } = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );

    const byId = new Map(
      excludeCredentials.map((entry) => [
        Array.from(new Uint8Array(entry.id)).join(","),
        entry,
      ]),
    );
    expect(
      byId.get(stored.credential.credentialId.join(","))?.transports,
    ).toEqual(["usb", "nfc"]);
    const absent = byId.get(
      withoutTransports.credential.credentialId.join(","),
    );
    expect(absent).toBeDefined();
    expect(absent).not.toHaveProperty("transports");
  });

  test("throws when a new handle collides with an existing handle", async () => {
    const t = setup();
    const restore = collideHandles();
    try {
      await t.mutation(api.registration.startRegistrationForExistingUser, {
        verifiedUserId: "user1",
      });
      await expect(
        t.mutation(api.registration.startRegistrationForExistingUser, {
          verifiedUserId: "user2",
        }),
      ).rejects.toThrow("collides with an existing handle");
    } finally {
      restore();
    }
    expect(await handleRows(t)).toHaveLength(1);
  });
});

describe("finishRegistrationForNewUser", () => {
  test("stores the passkey and links the handle to the verified user", async () => {
    const t = setup();
    const { credential, userHandle, finish } = await registrationArgs(
      t,
      "user1",
      { startUserId: null, counter: 5 },
    );
    const result = await finish();
    expect(result.success).toBe(true);

    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toHaveLength(1);
    expect(result).toEqual({ success: true, passkeyId: passkeys[0]._id });
    expect(passkeys[0].userId).toBe("user1");
    expect(passkeys[0].counter).toBe(5);
    expectSameBytes(passkeys[0].credentialId, credential.credentialId);

    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
    expectSameBytes(handles[0].handle, userHandle!);
  });

  test("returns PROTOCOL_ERROR for an existing-user ceremony", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      startUserId: "user1",
    });
    await expectProtocolError(
      () =>
        t.mutation(
          api.registration._internal_dangerous_finishRegistrationForNewUser,
          {
            ...args,
            newUserId: "user1",
          },
        ),
      "the ceremony comes from `existingUser`",
    );
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
    // The attempt burns the challenge, but the handle has an owner and stays.
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
    expect((await handleRows(t)).map((row) => row.userId)).toEqual(["user1"]);
  });

  test("throws for an unlinked handle when the user already has one", async () => {
    const t = setup();
    // A ceremony that starts as a new user, but that finishes with a user
    // that already has a handle. The invariant is that this cannot happen.
    const { finish } = await registrationArgs(t, "user1", {
      startUserId: null,
    });
    await t.run((ctx) =>
      ctx.db.insert("handles", {
        handle: new Uint8Array(64).fill(9).buffer,
        userId: "user1",
      }),
    );
    await expect(finish()).rejects.toThrow(
      "The user already has a different handle.",
    );
  });

  test("throws when the handle of the challenge no longer exists", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      startUserId: null,
    });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("handles").collect()) {
        await ctx.db.delete("handles", row._id);
      }
    });
    await expect(finish()).rejects.toThrow(
      "The handle of the challenge does not exist.",
    );
  });

  test("erases the unlinked handle of an expired challenge", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      startUserId: null,
    });
    expireChallenge();
    await finish();
    // The ceremony can never complete, thus its handle goes away too.
    expect(await handleRows(t)).toEqual([]);
  });

  test.each([
    { name: "the user is not verified", options: { userVerified: false } },
    {
      name: "the relying party ID does not match",
      options: { authDataRpId: "evil.example.net" },
    },
    {
      name: "the attested credential data is missing",
      options: { includeCredential: false },
    },
  ])(
    "erases the challenge and the unlinked handle when $name",
    async ({ options }) => {
      const t = setup();
      const { finish } = await registrationArgs(t, "user1", {
        startUserId: null,
        ...options,
      });
      const result = await finish();
      expect(result).toEqual({
        success: false,
        userError: { error: "PROTOCOL_ERROR" },
      });
      // The failure burned the challenge, so the cleanup loop cannot find
      // the handle later. The mutation must delete the handle itself.
      expect(await handleRows(t)).toEqual([]);
      expect(
        await t.run((ctx) => ctx.db.query("challenges").collect()),
      ).toEqual([]);
    },
  );
});

describe("finishRegistrationForExistingUser", () => {
  test("stores an ES256 passkey and consumes the challenge", async () => {
    const t = setup();
    const { credential, finish } = await registrationArgs(t, "user1", {
      counter: 5,
    });
    const result = await finish();
    expect(result.success).toBe(true);

    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toHaveLength(1);
    const row = passkeys[0];
    expect(result).toEqual({ success: true, passkeyId: row._id });
    expect(row.userId).toBe("user1");
    expectSameBytes(row.credentialId, credential.credentialId);
    expect(row.counter).toBe(5);
    // The stored key is the COSE key from the attestation, unchanged.
    expectSameBytes(row.publicKey, credential.cosePublicKey);

    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("stores the optional name", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      name: "MacBook Touch ID",
    });
    const result = await finish();
    expect(result.success).toBe(true);
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.name).toBe("MacBook Touch ID");
  });

  test("stores the transports that the client reports", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1");
    const result = await finish({ transports: ["internal", "hybrid"] });
    expect(result.success).toBe(true);
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.transports).toEqual(["internal", "hybrid"]);
  });

  test("stores no transports when the client reports none", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1");
    const result = await finish();
    expect(result.success).toBe(true);
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row).not.toHaveProperty("transports");
  });

  test("keeps the handle of a user that adds a second passkey", async () => {
    const t = setup();
    const first = await registrationArgs(t, "user1", { startUserId: null });
    await first.finish();
    const second = await registrationArgs(t, "user1");
    const result = await second.finish();

    expect(result.success).toBe(true);
    expectSameBytes(second.userHandle!, first.userHandle!);
    expect(await handleRows(t)).toHaveLength(1);
  });

  test("returns PROTOCOL_ERROR for a new-user ceremony", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      startUserId: null,
    });
    await expectProtocolError(
      () =>
        t.mutation(
          api.registration
            ._internal_dangerous_finishRegistrationForExistingUser,
          {
            ...args,
            verifiedUserId: "user1",
          },
        ),
      "the ceremony comes from `newUser`",
    );
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
    // The attempt burns the challenge, and the handle has no owner, thus it
    // goes away too.
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
    expect(await handleRows(t)).toEqual([]);
  });

  test("returns PROTOCOL_ERROR for a ceremony of a different user", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user2", {
      startUserId: "user1",
    });
    await expectProtocolError(
      finish,
      "created for a different user than the current user",
    );
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
    // The challenge burns, and the handle of user1 stays.
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
    expect((await handleRows(t)).map((row) => row.userId)).toEqual(["user1"]);
  });

  test("keeps the linked handle of an expired challenge", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1");
    expireChallenge();
    await finish();
    // The handle belongs to the user, thus it survives the dead ceremony.
    expect(await handleRows(t)).toHaveLength(1);
  });

  test("keeps the linked handle when the verification fails", async () => {
    const t = setup();
    await register(t, "user1");
    const { finish } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    const result = await finish();
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    // The handle belongs to user1, so the failed attempt must not remove it.
    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
  });
});

// The WebAuthn checks that run before either flow examines the handle. The
// tests drive them through the existing-user flow: the new-user flow runs
// the exact same code.
describe("finishRegistration verification", () => {
  test("stores an RS256 passkey as its COSE key", async () => {
    const t = setup();
    const credential = await generateRS256Credential();
    const { finish } = await registrationArgs(t, "user1", { credential });
    const result = await finish();
    expect(result.success).toBe(true);

    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    // A COSE key names its own algorithm, so RS256 needs no separate column.
    expectSameBytes(row.publicKey, credential.cosePublicKey);
  });

  test.each([
    {
      name: "too many transports",
      transports: Array.from({ length: 17 }, (_, i) => `t${i}`),
    },
    { name: "a transport that is too long", transports: ["a".repeat(33)] },
    { name: "an empty transport", transports: [""] },
    { name: "a transport with a non-ASCII character", transports: ["üsb"] },
    { name: "a transport with a space", transports: ["smart card"] },
  ])("returns PROTOCOL_ERROR for $name", async ({ transports }) => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1");
    // One message covers every rule, thus the values are what the logs
    // carry about this rejection.
    await expectProtocolError(
      () => finish({ transports }),
      `The client sent: ${JSON.stringify(transports)}.`,
    );
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
  });

  test("returns CHALLENGE_EXPIRED for an unknown challenge", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      challenge: toArrayBuffer(crypto.getRandomValues(new Uint8Array(32))),
    });
    expect(await finish()).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns CHALLENGE_EXPIRED for an expired challenge and deletes it", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1");
    expireChallenge();
    expect(await finish()).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("returns PROTOCOL_ERROR for an authentication client data type", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      clientDataType: "webauthn.get",
    });
    await expectProtocolError(
      finish,
      'a registration ceremony must send "webauthn.create"',
    );
  });

  test("returns PROTOCOL_ERROR for an unexpected origin without consuming the challenge", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      origin: "https://evil.example.net",
    });
    await expectProtocolError(
      finish,
      'the ceremony ran at the origin "https://evil.example.net"',
    );
    // The origin check happens before the challenge is consumed.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
  });

  test("accepts an origin from a list of expected origins", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      origin: ANDROID_ORIGIN,
      expectedOrigin: [ORIGIN, ANDROID_ORIGIN],
    });
    expect(await finish()).toMatchObject({ success: true });
  });

  test("returns PROTOCOL_ERROR for an origin missing from the list", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      origin: "https://evil.example.net",
      expectedOrigin: [ORIGIN, ANDROID_ORIGIN],
    });
    await expectProtocolError(
      finish,
      `the expected origins are "${ORIGIN}", "${ANDROID_ORIGIN}"`,
    );
  });

  test("throws for an empty list of expected origins", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      expectedOrigin: [],
    });
    await expect(finish()).rejects.toThrow("The origin list cannot be empty");
  });

  test("returns PROTOCOL_ERROR for a cross-origin ceremony", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      crossOrigin: true,
    });
    await expectProtocolError(
      finish,
      "the ceremony ran in a cross-origin frame",
    );
  });

  test("returns PROTOCOL_ERROR for a relying party ID hash mismatch", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      authDataRpId: "evil.example.net",
    });
    await expectProtocolError(
      finish,
      `does not match the expected relying party ID "${RP_ID}"`,
    );
  });

  test("returns PROTOCOL_ERROR when the user is not present", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      userPresent: false,
    });
    await expectProtocolError(
      finish,
      "no user presence or no user verification",
    );
  });

  test("returns PROTOCOL_ERROR when the user is not verified", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      userVerified: false,
    });
    await expectProtocolError(
      finish,
      "no user presence or no user verification",
    );
  });

  test("returns PROTOCOL_ERROR when the attested credential data is missing", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      includeCredential: false,
    });
    await expectProtocolError(finish, "carries no attested credential data");
  });

  test("returns PROTOCOL_ERROR when the client data JSON carries no challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1");
    await expectProtocolError(
      () =>
        t.mutation(
          api.registration
            ._internal_dangerous_finishRegistrationForExistingUser,
          {
            ...args,
            verifiedUserId: "user1",
            response: {
              ...args.response,
              response: {
                ...args.response.response,
                clientDataJSON: toBase64URL(
                  new TextEncoder().encode(
                    JSON.stringify({ type: "webauthn.create", origin: ORIGIN }),
                  ),
                ),
              },
            },
          },
        ),
      "the client data JSON carries no challenge",
    );
  });

  test("returns PROTOCOL_ERROR for an unsupported public key algorithm", async () => {
    const t = setup();
    const credential = await generateES256Credential();
    // An EdDSA (-8) COSE key.
    credential.cosePublicKey = encodeCBOR(
      new Map<number, number | Uint8Array>([
        [1, 1], // kty: OKP
        [3, -8], // alg: EdDSA
        [-1, 6], // crv: Ed25519
        [-2, new Uint8Array(32)],
      ]),
    );
    const { finish } = await registrationArgs(t, "user1", { credential });
    // The message of `@simplewebauthn/server` names the algorithms the
    // ceremony offered. The assertion stays on the wrapper this component
    // adds, because the wording of the library is not part of its contract.
    await expectProtocolError(finish, "the attestation did not verify");
  });

  test("returns PROTOCOL_ERROR for a duplicate credential ID", async () => {
    const t = setup();
    await register(t, "user1");
    const { credential } = await register(t, "user1");
    // A second ceremony for a new user, with a credential that exists.
    // A compliant client cannot cause this.
    const { finish } = await registrationArgs(t, "user2", {
      startUserId: null,
      credential,
    });
    await expectProtocolError(finish, "the credential is already registered");
    // The attempt burns the challenge, and the unlinked handle of the new
    // user goes away with it.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
    expect((await handleRows(t)).map((row) => row.userId)).toEqual(["user1"]);
  });
});

describe("checkRegistrationForNewUser", () => {
  /** The check takes the finish arguments without the user fields. */
  function checkArgs({
    expectedRpId,
    expectedOrigin,
    response,
    name,
  }: Awaited<ReturnType<typeof registrationArgs>>["args"]) {
    return { expectedRpId, expectedOrigin, response, name };
  }

  test("returns success for a valid attestation and writes nothing", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { startUserId: null });
    const result = await t.query(
      api.registration.checkRegistrationForNewUser,
      checkArgs(args),
    );
    expect(result).toEqual({ success: true });
    // A query cannot write: the challenge stays for the finish call.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
  });

  test("returns PROTOCOL_ERROR for an existing-user ceremony", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      startUserId: "user1",
    });
    await expectProtocolError(
      () =>
        t.query(api.registration.checkRegistrationForNewUser, checkArgs(args)),
      "the ceremony comes from `existingUser`",
    );
  });

  test("returns CHALLENGE_EXPIRED for an expired challenge", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { startUserId: null });
    expireChallenge();
    const result = await t.query(
      api.registration.checkRegistrationForNewUser,
      checkArgs(args),
    );
    expect(result).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns PROTOCOL_ERROR when the user is not verified", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      startUserId: null,
      userVerified: false,
    });
    await expectProtocolError(
      () =>
        t.query(api.registration.checkRegistrationForNewUser, checkArgs(args)),
      "no user presence or no user verification",
    );
  });

  test("returns PROTOCOL_ERROR for a duplicate credential ID", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { args } = await registrationArgs(t, "user2", {
      startUserId: null,
      credential,
    });
    await expectProtocolError(
      () =>
        t.query(api.registration.checkRegistrationForNewUser, checkArgs(args)),
      "the credential is already registered",
    );
  });

  test("returns PROTOCOL_ERROR for an unexpected origin, like the finish call", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", {
      startUserId: null,
      origin: "https://evil.example.net",
    });
    await expectProtocolError(
      () =>
        t.query(api.registration.checkRegistrationForNewUser, checkArgs(args)),
      'the ceremony ran at the origin "https://evil.example.net"',
    );
  });

  test("returns PROTOCOL_ERROR for transports that the client made up", async () => {
    const t = setup();
    const { args } = await registrationArgs(t, "user1", { startUserId: null });
    await expectProtocolError(
      () =>
        t.query(api.registration.checkRegistrationForNewUser, {
          ...checkArgs(args),
          response: {
            ...args.response,
            response: {
              ...args.response.response,
              transports: ["smart card"],
            },
          },
        }),
      'The client sent: ["smart card"].',
    );
  });

  test("a finish with the same arguments succeeds after a successful check", async () => {
    const t = setup();
    const { args, finish } = await registrationArgs(t, "user1", {
      startUserId: null,
    });
    const check = await t.query(
      api.registration.checkRegistrationForNewUser,
      checkArgs(args),
    );
    expect(check).toEqual({ success: true });
    const result = await finish();
    expect(result.success).toBe(true);
  });

  test("returns INVALID_NAME for a name that the finish call refuses", async () => {
    const t = setup();
    const { args, finish } = await registrationArgs(t, "user1", {
      startUserId: null,
      name: "   ",
    });
    const invalid = { success: false, userError: { error: "INVALID_NAME" } };
    expect(
      await t.query(
        api.registration.checkRegistrationForNewUser,
        checkArgs(args),
      ),
    ).toEqual(invalid);
    expect(await finish()).toEqual(invalid);
  });
});

describe("passkey names at registration", () => {
  const invalidNames = {
    "only whitespace": "   ",
    "a C1 control": "os\u009dcontrol",
    "a line feed": "two\nlines",
    "a right-to-left override": "Mac\u202eBook",
    "a zero-width space": "Mac\u200bBook",
    "a byte order mark": "Mac\ufeffBook",
    "51 code points": "a".repeat(MAX_PASSKEY_NAME_LENGTH + 1),
    "51 astral code points": "😀".repeat(MAX_PASSKEY_NAME_LENGTH + 1),
  };

  test("refuses a name that the component could not store", async () => {
    const t = setup();
    let userId = 0;
    for (const [description, name] of Object.entries(invalidNames)) {
      const { finish } = await registrationArgs(t, `user${userId++}`, { name });
      expect(await finish(), description).toEqual({
        success: false,
        userError: { error: "INVALID_NAME" },
      });
    }
    // The challenges survive, so the same ceremonies can be finished again
    // with names the component stores.
    expect(
      await t.run((ctx) => ctx.db.query("challenges").collect()),
    ).toHaveLength(Object.keys(invalidNames).length);
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
  });

  test("refuses a name that the component could not store, for a new user", async () => {
    const t = setup();
    const { finish } = await registrationArgs(t, "user1", {
      startUserId: null,
      name: "os\u009dcontrol",
    });
    expect(await finish()).toEqual({
      success: false,
      userError: { error: "INVALID_NAME" },
    });
    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
  });

  test("stores a name that is at the limit or that needs a joiner", async () => {
    const t = setup();
    // The limit counts code points, thus an astral character counts as one.
    const accepted = [
      "a".repeat(MAX_PASSKEY_NAME_LENGTH),
      "😀".repeat(MAX_PASSKEY_NAME_LENGTH),
      // A zero-width joiner is necessary for some scripts and for emoji
      // sequences, thus it stays permitted.
      "family\u{1f468}\u200d\u{1f469}\u200d\u{1f466}",
    ];
    let userId = 0;
    for (const name of accepted) {
      const { finish } = await registrationArgs(t, `user${userId++}`, { name });
      expect(await finish(), name).toMatchObject({ success: true });
    }
    expect(
      await t.run(async (ctx) =>
        (await ctx.db.query("passkeys").collect()).map((row) => row.name),
      ),
    ).toEqual(accepted);
  });
});

describe("renamePasskey", () => {
  test("renames the user's own passkey", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1", { name: "Old name" });
    const result = await t.mutation(api.registration.renamePasskey, {
      userId: "user1",
      passkeyId,
      name: "New name",
    });
    expect(result).toEqual({ success: true });
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.name).toBe("New name");
  });

  test("refuses a passkey of another user", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1", { name: "Old name" });
    const result = await t.mutation(api.registration.renamePasskey, {
      userId: "user2",
      passkeyId,
      name: "New name",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.name).toBe("Old name");
  });

  test("refuses an unknown passkey id", async () => {
    const t = setup();
    await register(t, "user1");
    expect(
      await t.mutation(api.registration.renamePasskey, {
        userId: "user1",
        passkeyId: "not a passkey id",
        name: "New name",
      }),
    ).toEqual({ success: false, userError: { error: "PASSKEY_NOT_FOUND" } });
  });

  test("refuses names that are not short labels", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1", { name: "Old name" });
    const rename = (name: string) =>
      t.mutation(api.registration.renamePasskey, {
        userId: "user1",
        passkeyId,
        name,
      });
    const invalid = { success: false, userError: { error: "INVALID_NAME" } };
    expect(await rename("")).toEqual(invalid);
    expect(await rename("   ")).toEqual(invalid);
    expect(await rename("x".repeat(51))).toEqual(invalid);
    expect(await rename("line\nbreak")).toEqual(invalid);
    // A C1 control, which the C0 range does not cover.
    expect(await rename("os\u009dcontrol")).toEqual(invalid);
    // 50 code points are the limit, also for astral characters.
    expect(await rename("\u{1f511}".repeat(50))).toEqual({ success: true });
  });
});

describe("listPasskeys", () => {
  test("returns an empty array for an unknown user", async () => {
    const t = setup();
    const result = await t.query(api.registration.listPasskeys, {
      userId: "nobody",
    });
    expect(result).toEqual([]);
  });

  test("returns only the user's passkeys with public metadata only", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1", {
      name: "MacBook",
    });
    await register(t, "user2");
    const result = await t.query(api.registration.listPasskeys, {
      userId: "user1",
    });
    expect(result).toHaveLength(1);
    expect(result[0].passkeyId).toBe(passkeyId);
    expect(result[0].name).toBe("MacBook");
    expect(result[0].credentialId).toBe(toBase64URL(credential.credentialId));
    expect(typeof result[0].createdAt).toBe("number");
    // The key material never leaves the component.
    expect(result[0]).not.toHaveProperty("publicKey");
    expect(result[0]).not.toHaveProperty("counter");
  });
});

describe("deletePasskey", () => {
  test("deletes the user's own passkey", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1");
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });
    expect(result).toEqual({ success: true });
    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toEqual([]);
  });

  test("keeps the handle so a later passkey reuses it", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1");
    const [handle] = await handleRows(t);
    await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });

    // The user keeps their handle, thus a new passkey reuses it.
    const handles = await handleRows(t);
    expect(handles).toHaveLength(1);
    expect(handles[0].userId).toBe("user1");
    const next = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    expectSameBytes(next.userHandle, handle.handle);
  });

  test("refuses to delete another user's passkey", async () => {
    const t = setup();
    const { passkeyId: user1PasskeyId } = await register(t, "user1");
    const { passkeyId: user2PasskeyId } = await register(t, "user2");
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user2",
      passkeyId: user1PasskeyId,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys).toHaveLength(2);
    expect(passkeys.map((p) => p._id)).toEqual(
      expect.arrayContaining([user1PasskeyId, user2PasskeyId]),
    );
  });

  test("returns PASSKEY_NOT_FOUND for a malformed ID", async () => {
    const t = setup();
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId: "not-a-real-id",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
  });

  test("returns PASSKEY_NOT_FOUND on a double delete", async () => {
    const t = setup();
    const { passkeyId } = await register(t, "user1");
    await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });
    const result = await t.mutation(api.registration.deletePasskey, {
      userId: "user1",
      passkeyId,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSKEY_NOT_FOUND" },
    });
  });
});

describe("deleteUser", () => {
  test("erases the passkeys, the handle, and the challenges of the user", async () => {
    const t = setup();
    await register(t, "user1");
    await register(t, "user1");
    const authenticationChallengeId = await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "authentication",
        purpose: "test",
        challenge: new Uint8Array(32).fill(0xaa).buffer,
        userId: "user1",
      }),
    );

    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    expect(await t.run((ctx) => ctx.db.query("passkeys").collect())).toEqual(
      [],
    );
    expect(await handleRows(t)).toEqual([]);
    expect(
      await t.run((ctx) => ctx.db.get("challenges", authenticationChallengeId)),
    ).toBe(null);
  });

  test("keeps an in-flight registration challenge until the TTL", async () => {
    const t = setup();
    await register(t, "user1");
    // An in-flight ceremony that adds a passkey to the user.
    await t.mutation(api.registration.startRegistrationForExistingUser, {
      verifiedUserId: "user1",
    });

    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    // A registration challenge has no `userId`, thus it survives. That is
    // safe: its handle is gone, so a finish attempt throws, and the cleanup
    // loop erases the challenge after the TTL.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
    expect(challenges[0].kind).toBe("registration");
  });

  test("keeps the rows of the other users", async () => {
    const t = setup();
    await register(t, "user1");
    await register(t, "user2");
    const otherChallengeId = await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "authentication",
        purpose: "test",
        challenge: new Uint8Array(32).fill(0xbb).buffer,
        userId: "user2",
      }),
    );
    // A discoverable-credential challenge has no user: it survives too.
    const anonymousChallengeId = await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "authentication",
        purpose: "test",
        challenge: new Uint8Array(32).fill(0xcc).buffer,
      }),
    );

    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    const passkeys = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(passkeys.map((row) => row.userId)).toEqual(["user2"]);
    const handles = await handleRows(t);
    expect(handles.map((row) => row.userId)).toEqual(["user2"]);
    expect(
      await t.run((ctx) => ctx.db.get("challenges", otherChallengeId)),
    ).not.toBe(null);
    expect(
      await t.run((ctx) => ctx.db.get("challenges", anonymousChallengeId)),
    ).not.toBe(null);
  });

  test("gives a new handle to a user that registers again", async () => {
    const t = setup();
    await register(t, "user1");
    const [first] = await handleRows(t);
    await t.mutation(api.registration.deleteUser, { userId: "user1" });

    const second = await t.mutation(
      api.registration.startRegistrationForExistingUser,
      { verifiedUserId: "user1" },
    );
    expect(new Uint8Array(second.userHandle)).not.toEqual(
      new Uint8Array(first.handle),
    );
  });

  test("does nothing for a user with no passkey data", async () => {
    const t = setup();
    await register(t, "user1");

    await t.mutation(api.registration.deleteUser, { userId: "user2" });

    expect(
      await t.run((ctx) => ctx.db.query("passkeys").collect()),
    ).toHaveLength(1);
    expect(await handleRows(t)).toHaveLength(1);
  });
});
