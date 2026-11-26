import { describe, expect, test } from "vitest";
import { REDACTED } from "./events.ts";
import { redactDocument, scrubText } from "./redact.ts";

describe("redactDocument", () => {
  test("replaces the hash of a refresh token, keeps its ids and state", () => {
    expect(
      redactDocument("refreshTokens", {
        _id: "j97bgasf0v4bydaj9s7hq156vx8jyhxn",
        _creationTime: 1795730172885.2495,
        hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001",
        sessionId: "jd7csg27mkg08chjt3arcrpry98jyxw4",
        state: "spent",
        retiredAt: 1795730174486,
      }),
    ).toEqual({
      _id: "j97bgasf0v4bydaj9s7hq156vx8jyhxn",
      _creationTime: 1795730172885.2495,
      hash: REDACTED,
      sessionId: "jd7csg27mkg08chjt3arcrpry98jyxw4",
      state: "spent",
      retiredAt: 1795730174486,
    });
  });

  test("replaces the hash of a password", () => {
    expect(
      redactDocument("passwords", {
        _id: "j57fsrj6jcqvcq3jdycw83v9y18jzz8r",
        passwordHashPHC: "$argon2id$v=19$m=16384,t=3,p=1$c2FsdA$aGFzaA",
        userId: "j573smrb10w028aq9jwgh1c5hs8jznta",
      }),
    ).toEqual({
      _id: "j57fsrj6jcqvcq3jdycw83v9y18jzz8r",
      passwordHashPHC: REDACTED,
      userId: "j573smrb10w028aq9jwgh1c5hs8jznta",
    });
  });

  test("in a table it does not know, keeps ids, numbers, and flags only", () => {
    expect(
      redactDocument("apiClients", {
        _id: "k17bgasf0v4bydaj9s7hq156vx8jyhxn",
        ownerId: "j573smrb10w028aq9jwgh1c5hs8jznta",
        label: "my laptop",
        clientKey: "abc",
        retries: 2,
        active: true,
        revokedAt: null,
        settings: { theme: "dark", count: 3, nested: [{ note: "x" }] },
      }),
    ).toEqual({
      _id: "k17bgasf0v4bydaj9s7hq156vx8jyhxn",
      ownerId: "j573smrb10w028aq9jwgh1c5hs8jznta",
      label: REDACTED,
      clientKey: REDACTED,
      retries: 2,
      active: true,
      revokedAt: null,
      settings: { theme: REDACTED, count: 3, nested: [{ note: REDACTED }] },
    });
  });

  test("a secret name wins over the list of safe fields", () => {
    expect(
      redactDocument("challenges", {
        email: "a@example.com",
        emailCodeHash: "abc",
        browserSecretHash: "def",
        expiresAt: 5,
      }),
    ).toEqual({
      email: "a@example.com",
      emailCodeHash: REDACTED,
      browserSecretHash: REDACTED,
      expiresAt: 5,
    });
  });

  test("a numeric secret is replaced", () => {
    expect(redactDocument("otps", { code: 123456, otpCounter: 3 })).toEqual({
      code: REDACTED,
      otpCounter: REDACTED,
    });
  });
});

describe("scrubText", () => {
  test("replaces tokens, hashes, and keys", () => {
    const refreshToken = "Ab3CDEF_GHIjKlM4Nop5Q678r9ST0U1vW2XY-zABc4d";
    expect(
      scrubText(
        [
          "jwt eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl",
          `refresh ${refreshToken}`,
          "hash ffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001",
          "phc $argon2id$v=19$m=16384,t=3,p=1$c2FsdA$aGFzaA",
          "key dev:happy-cat-123|eyAbc123",
        ].join("\n"),
      ),
    ).toBe(
      [
        `jwt ${REDACTED}`,
        `refresh ${REDACTED}`,
        `hash ${REDACTED}`,
        `phc ${REDACTED}`,
        `key ${REDACTED}`,
      ].join("\n"),
    );
  });

  test("keeps ids, function names, and prose", () => {
    const text =
      "authPassword/public/_internal_dangerous_setPassword j573smrb10w028aq9jwgh1c5hs8jznta Spent refresh token used: a later token was already redeemed.";
    expect(scrubText(text)).toBe(text);
  });
});
