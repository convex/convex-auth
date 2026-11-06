import {
  ORIGIN,
  RP_ID,
  buildAssertion,
  generateES256Credential,
  generateRS256Credential,
  toBase64URL,
} from "@convex-dev/passkey-test-authenticator";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  expectProtocolError,
  expectSameBytes,
  register,
  setup,
} from "../passkeyTestSetup.ts";
import { api } from "./_generated/api.ts";
import { type WireAuthenticationResponse } from "./validation.ts";
import { CHALLENGE_TTL_MS } from "./constants.ts";

// The component gives no purpose of its own: each app names its own flows.
const PURPOSE = "test/signIn";
const OTHER_PURPOSE = "test/removePasskey";

const EXPECTED = {
  purpose: PURPOSE,
  expectedRpId: RP_ID,
  expectedOrigin: ORIGIN,
};

// Only the expiry test moves the clock, but the restore is global to keep the
// other tests on the real clock.
afterEach(() => {
  vi.useRealTimers();
});

/** Replace fields inside the inner `response` of an assertion envelope. */
function withInner(
  assertion: { response: WireAuthenticationResponse },
  fields: Partial<WireAuthenticationResponse["response"]>,
) {
  return {
    response: {
      ...assertion.response,
      response: { ...assertion.response.response, ...fields },
    },
  };
}

describe("startAuthentication", () => {
  test("stores a user-bound challenge and returns the user's credential IDs", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    await register(t, "user2");
    const { challenge, allowCredentials } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    expect(new Uint8Array(challenge).length).toBe(32);
    expect(allowCredentials).toHaveLength(1);
    expectSameBytes(allowCredentials[0].id, credential.credentialId);
    const [row] = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(row.kind).toBe("authentication");
    expect(row.kind === "authentication" && row.userId).toBe("user1");
    expect(row.kind === "authentication" && row.purpose).toBe(PURPOSE);
  });

  test("returns the transports of each passkey in allowCredentials", async () => {
    const t = setup();
    const stored = await register(t, "user1", { transports: ["hybrid"] });
    const withoutTransports = await register(t, "user1");
    const { allowCredentials } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );

    const byId = new Map(
      allowCredentials.map((entry) => [
        Array.from(new Uint8Array(entry.id)).join(","),
        entry,
      ]),
    );
    expect(
      byId.get(stored.credential.credentialId.join(","))?.transports,
    ).toEqual(["hybrid"]);
    const absent = byId.get(
      withoutTransports.credential.credentialId.join(","),
    );
    expect(absent).toBeDefined();
    expect(absent).not.toHaveProperty("transports");
  });

  test("stores an unbound challenge with no allowCredentials for the discoverable flow", async () => {
    const t = setup();
    await register(t, "user1");
    const { allowCredentials } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE },
    );
    expect(allowCredentials).toEqual([]);
    const [row] = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(row.kind === "authentication" && row.userId).toBe(undefined);
  });

  test("refuses purposes with invalid formats", async () => {
    const t = setup();
    for (const purpose of ["", "test signIn", "test/sign\u0000In", "é"]) {
      await expect(
        t.mutation(api.authentication.startAuthentication, { purpose }),
      ).rejects.toThrow("Invalid purpose");
    }
    // The error shows the start of the purpose, to help the developer find
    // the value that the app sent.
    await expect(
      t.mutation(api.authentication.startAuthentication, {
        purpose: `${"x".repeat(128)}yyy`,
      }),
    ).rejects.toThrow(`Purpose too long: "${"x".repeat(128)}\u2026" has 131`);
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
  });
});

describe("finishAuthentication", () => {
  test("authenticates with an ES256 passkey and consumes the challenge", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      counter: 7,
    });
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });

    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.counter).toBe(7);
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("accepts an assertion whose counter did not increase", async () => {
    // The component deliberately does not enforce counter growth: most
    // authenticators always report 0, and a synced passkey can report a
    // counter that moved backwards (see the `counter: 0` override in
    // `finishAuthentication`).
    const t = setup();
    const { credential } = await register(t, "user1");
    const authenticate = async (counter: number) => {
      const { challenge } = await t.mutation(
        api.authentication.startAuthentication,
        { purpose: PURPOSE, userId: "user1" },
      );
      const assertion = await buildAssertion(credential, challenge, {
        counter,
      });
      return t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      });
    };

    expect((await authenticate(7)).success).toBe(true);
    // The same counter, and a counter that moved backwards, both pass.
    expect((await authenticate(7)).success).toBe(true);
    expect((await authenticate(3)).success).toBe(true);
    // The reported value is still recorded for a future flow.
    const [row] = await t.run((ctx) => ctx.db.query("passkeys").collect());
    expect(row.counter).toBe(3);
  });

  test("authenticates with an RS256 passkey", async () => {
    const t = setup();
    const credential = await generateRS256Credential();
    const { passkeyId } = await register(t, "user1", { credential });
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });
  });

  test("identifies the user in the discoverable flow", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });
  });

  test("returns UNKNOWN_CREDENTIAL without consuming the challenge", async () => {
    const t = setup();
    await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const unregistered = await generateES256Credential();
    const assertion = await buildAssertion(unregistered, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "UNKNOWN_CREDENTIAL" },
    });
    // The challenge survives an attempt with an unknown credential.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
  });

  test("returns PROTOCOL_ERROR for authenticator data that is too short", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...withInner(assertion, {
            authenticatorData: toBase64URL(new Uint8Array(10)),
          }),
        }),
      "the authenticator data could not be read",
    );
  });

  test("returns PROTOCOL_ERROR when the client data JSON carries no challenge", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...withInner(assertion, {
            clientDataJSON: toBase64URL(
              new TextEncoder().encode(
                JSON.stringify({ type: "webauthn.get", origin: ORIGIN }),
              ),
            ),
          }),
        }),
      // The verifier reports this case, because the component does not
      // read the challenge out of the client data.
      "the assertion did not verify",
    );
  });

  test("returns PROTOCOL_ERROR for a relying party ID hash mismatch", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      rpId: "evil.example.net",
    });
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...assertion,
        }),
      `does not match the expected relying party ID "${RP_ID}"`,
    );
  });

  test("returns PROTOCOL_ERROR when the user is not present or not verified", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    // The flag checks run before the challenge is consumed, so the same
    // challenge can serve both variants.
    for (const flags of [{ userPresent: false }, { userVerified: false }]) {
      const assertion = await buildAssertion(credential, challenge, flags);
      const result = await t.mutation(api.authentication.finishAuthentication, {
        ...EXPECTED,
        ...assertion,
      });
      expect(result).toEqual({
        success: false,
        userError: { error: "PROTOCOL_ERROR" },
      });
    }
  });

  test("returns PROTOCOL_ERROR for a registration client data type", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      type: "webauthn.create",
    });
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...assertion,
        }),
      'an authentication ceremony must send "webauthn.get"',
    );
  });

  test("returns PROTOCOL_ERROR for an unexpected origin", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      origin: "https://evil.example.net",
    });
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...assertion,
        }),
      'the ceremony ran at the origin "https://evil.example.net"',
    );
  });

  test("returns PROTOCOL_ERROR for a cross-origin ceremony", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge, {
      crossOrigin: true,
    });
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...assertion,
        }),
      "the ceremony ran in a cross-origin frame",
    );
  });

  test("returns CHALLENGE_EXPIRED for an expired challenge", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    // The age of a challenge is the age of its `_creationTime`, thus the
    // clock is the only way to make the challenge expire.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + CHALLENGE_TTL_MS + 1000);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns PROTOCOL_ERROR when the challenge is bound to another user", async () => {
    const t = setup();
    await register(t, "userA");
    const { credential: credentialB } = await register(t, "userB");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "userA" },
    );
    const assertion = await buildAssertion(credentialB, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    // The mismatch happens after consumption: the challenge is burned.
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toEqual([]);
  });

  test("returns PROTOCOL_ERROR for an ES256 signature by the wrong key", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const otherKey = await generateES256Credential();
    const assertion = await buildAssertion(credential, challenge, {
      signWith: otherKey,
    });
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
  });

  test("returns PROTOCOL_ERROR for invalid RS256 signature bytes", async () => {
    const t = setup();
    const credential = await generateRS256Credential();
    await register(t, "user1", { credential });
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...withInner(assertion, {
        signature: toBase64URL(crypto.getRandomValues(new Uint8Array(256))),
      }),
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
  });

  test("returns PROTOCOL_ERROR for an empty RS256 signature", async () => {
    // The RSA verification decodes the signature as a big integer, which
    // refuses zero bytes. The mutation must not throw.
    const t = setup();
    const credential = await generateRS256Credential();
    await register(t, "user1", { credential });
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...withInner(assertion, { signature: toBase64URL(new Uint8Array(0)) }),
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
  });

  test("returns PROTOCOL_ERROR for ES256 signature bytes that are not DER", async () => {
    // No authenticator sends bytes that the decoder refuses.
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...withInner(assertion, { signature: toBase64URL(new Uint8Array(10)) }),
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
  });

  test("returns PROTOCOL_ERROR for an ES256 signature where s is the order of the curve", async () => {
    // The DER is correct, but `s` has no inverse modulo the order of the
    // curve. The verification must not throw.
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    // SEQUENCE { INTEGER 1, INTEGER n } where n is the order of P-256.
    const signature = Uint8Array.from([
      0x30, 0x26, 0x02, 0x01, 0x01, 0x02, 0x21, 0x00, 0xff, 0xff, 0xff, 0xff,
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2,
      0xfc, 0x63, 0x25, 0x51,
    ]);
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...withInner(assertion, { signature: toBase64URL(signature) }),
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
  });

  // The checks below run before the challenge lookup, so each one keeps the
  // challenge. This is an ordering of the checks, not a guarantee about
  // protocol errors: a check that runs after the lookup consumes the
  // challenge, and a bad signature is one of them.
  test("the checks before the challenge lookup keep the challenge", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    // Each of these checks runs before the challenge is consumed, so the
    // same challenge serves each variant in turn.
    const variants = [
      { rpId: "evil.example.net" },
      { type: "webauthn.create" as const },
      { origin: "https://evil.example.net" },
      { crossOrigin: true },
    ];
    for (const variant of variants) {
      const assertion = await buildAssertion(credential, challenge, variant);
      await expectProtocolError(
        () =>
          t.mutation(api.authentication.finishAuthentication, {
            ...EXPECTED,
            ...assertion,
          }),
        "Rejected the passkey ceremony",
      );
    }
    const challenges = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(challenges).toHaveLength(1);
  });

  test("rejects a replayed assertion with CHALLENGE_EXPIRED", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    const first = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(first.success).toBe(true);
    const second = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("returns PROTOCOL_ERROR for a different purpose and burns the challenge", async () => {
    const t = setup();
    const { credential } = await register(t, "user1");
    const { challenge } = await t.mutation(
      api.authentication.startAuthentication,
      { purpose: PURPOSE, userId: "user1" },
    );
    const assertion = await buildAssertion(credential, challenge);
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...assertion,
          purpose: OTHER_PURPOSE,
        }),
      `the challenge was created for the purpose "${PURPOSE}", but the ceremony was finished for the purpose "${OTHER_PURPOSE}"`,
    );

    // The purpose check runs after the delete. A mismatch comes from the
    // code of the app, so the same ceremony would fail again anyway.
    const retry = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...assertion,
    });
    expect(retry).toEqual({
      success: false,
      userError: { error: "CHALLENGE_EXPIRED" },
    });
  });

  test("keeps the challenges of two purposes independent", async () => {
    const t = setup();
    const { credential, passkeyId } = await register(t, "user1");
    const signIn = await t.mutation(api.authentication.startAuthentication, {
      purpose: PURPOSE,
      userId: "user1",
    });
    const other = await t.mutation(api.authentication.startAuthentication, {
      purpose: OTHER_PURPOSE,
      userId: "user1",
    });

    // The challenge of the other flow is unusable for the sign-in flow.
    const otherAssertion = await buildAssertion(credential, other.challenge);
    await expectProtocolError(
      () =>
        t.mutation(api.authentication.finishAuthentication, {
          ...EXPECTED,
          ...otherAssertion,
        }),
      "the challenge was created for the purpose",
    );

    // The failed attempt leaves the challenge of the sign-in flow alone.
    const result = await t.mutation(api.authentication.finishAuthentication, {
      ...EXPECTED,
      ...(await buildAssertion(credential, signIn.challenge)),
    });
    expect(result).toEqual({ success: true, userId: "user1", passkeyId });
  });
});
