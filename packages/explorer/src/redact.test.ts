import { describe, expect, test } from "vitest";
import { REDACTED } from "./events.ts";
import { convexAuthProject } from "./projects/convexAuth.ts";
import { redactDocument, redactUrl, scrubText } from "./redact.ts";

describe("redactDocument", () => {
  test("replaces the hash of a refresh token, keeps its ids and state", () => {
    expect(
      redactDocument(
        "refreshTokens",
        {
          _id: "j97bgasf0v4bydaj9s7hq156vx8jyhxn",
          _creationTime: 1795730172885.2495,
          hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000001",
          sessionId: "jd7csg27mkg08chjt3arcrpry98jyxw4",
          state: "spent",
          retiredAt: 1795730174486,
        },
        convexAuthProject,
      ),
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

  test("without a project config, keeps no string of a known table", () => {
    expect(
      redactDocument("refreshTokens", { state: "issued", hash: "abc" }),
    ).toEqual({ state: REDACTED, hash: REDACTED });
  });

  test("keeps personal data only when the project says so", () => {
    const user = { username: "dave", usernameNormalized: "dave" };
    expect(redactDocument("usernames", user, convexAuthProject)).toEqual(user);
    expect(
      redactDocument("usernames", user, {
        ...convexAuthProject,
        keepPersonalData: false,
      }),
    ).toEqual({ username: REDACTED, usernameNormalized: REDACTED });
  });

  test("a secret name wins over the fields that the project keeps", () => {
    expect(
      redactDocument(
        "challenges",
        {
          email: "a@example.com",
          emailCodeHash: "abc",
          browserSecretHash: "def",
          expiresAt: 5,
        },
        convexAuthProject,
      ),
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

describe("the convex-auth config", () => {
  test("keeps the origin and the path of redirectTo, not its query", () => {
    expect(
      redactDocument(
        "authorizationRequests",
        {
          _id: "k17bgasf0v4bydaj9s7hq156vx8jyhxn",
          providerName: "google",
          redirectTo:
            "https://app.example/after?invite=alice%40example.com#top",
          callbackUrl: "https://deployment.example/api/auth/callback/google",
        },
        convexAuthProject,
      ),
    ).toMatchObject({
      redirectTo: `https://app.example/after?invite=${REDACTED}#${REDACTED}`,
      callbackUrl: "https://deployment.example/api/auth/callback/google",
    });
  });

  test("treats the account at the provider and the name of a passkey as personal", () => {
    const account = {
      providerName: "github",
      providerAccountId: "12345",
    };
    const passkey = { name: "Alice's laptop", transports: ["internal"] };
    expect(redactDocument("accounts", account, convexAuthProject)).toEqual(
      account,
    );
    expect(redactDocument("passkeys", passkey, convexAuthProject)).toEqual(
      passkey,
    );
    const dropped = { ...convexAuthProject, keepPersonalData: false };
    expect(redactDocument("accounts", account, dropped)).toEqual({
      providerName: "github",
      providerAccountId: REDACTED,
    });
    expect(redactDocument("passkeys", passkey, dropped)).toEqual({
      name: REDACTED,
      transports: ["internal"],
    });
  });
});

describe("redactUrl", () => {
  test("replaces query values and the fragment, and what is not a URL", () => {
    expect(redactUrl("http://localhost:5173/login")).toBe(
      "http://localhost:5173/login",
    );
    expect(redactUrl("https://a.example/cb?code=xyz&state=abc")).toBe(
      `https://a.example/cb?code=${REDACTED}&state=${REDACTED}`,
    );
    expect(redactUrl("/relative?x=1")).toBe(REDACTED);
  });
});
