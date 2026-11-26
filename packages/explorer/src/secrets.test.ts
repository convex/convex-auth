import { describe, expect, test } from "vitest";
import { nodeDigest } from "./nodeDigest.ts";
import { GENERIC_BROWSER, type BrowserProjectConfig } from "./project.ts";
import { decodeJwt, isJwt, safeClaims, Secrets } from "./secrets.ts";

const b64 = (value: object) =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const SESSION_ID = "jd7avjheb59dwvs75ekm6vf79x8jzqa0";
const jwt = `${b64({ alg: "ES256", typ: "JWT", kid: "key-1" })}.${b64({
  sub: SESSION_ID,
  aud: "convex-auth",
  jti: "unique",
  iat: 1000,
  exp: 1060,
})}.fake-signature`;
const refreshToken = "rRjkqSPm0wjYNVmGjXGa4LJpQHbtpPpW1yJy5OZkj_Y";

const config: BrowserProjectConfig = {
  ...GENERIC_BROWSER,
  safeJwtClaims: ["sub", "aud"],
  secretDigests: [
    { table: "refreshTokens", field: "hash", digest: "sha256Hex" },
  ],
  claimLinks: [{ claim: "sub", table: "sessions" }],
};

describe("JWTs", () => {
  test("decodes the header and the claims, not the signature", () => {
    expect(isJwt(jwt)).toBe(true);
    expect(isJwt(refreshToken)).toBe(false);
    expect(decodeJwt(jwt)?.claims.sub).toBe(SESSION_ID);
  });

  test("keeps the numeric claims and the safe string claims", () => {
    const { claims } = decodeJwt(jwt)!;
    expect(safeClaims(claims, [])).toEqual({ iat: 1000, exp: 1060 });
    expect(safeClaims(claims, ["sub", "aud"])).toEqual({
      sub: SESSION_ID,
      aud: "convex-auth",
      iat: 1000,
      exp: 1060,
    });
  });
});

describe("Secrets", () => {
  test("gives one label to one value, and a secret event the first time", () => {
    const secrets = new Secrets(config, nodeDigest);
    expect(secrets.ref(jwt, 1, "a")).toEqual({ $secret: "s1" });
    expect(secrets.ref(refreshToken, 2, "b")).toEqual({ $secret: "s2" });
    expect(secrets.ref(jwt, 3, "c")).toEqual({ $secret: "s1" });
    const events = secrets.drain();
    expect(events).toEqual([
      {
        kind: "secret",
        id: "s1",
        time: 1,
        type: "jwt",
        firstSeenIn: "a",
        claims: { sub: SESSION_ID, aud: "convex-auth", iat: 1000, exp: 1060 },
        header: { alg: "ES256", typ: "JWT", kid: "key-1" },
      },
      {
        kind: "secret",
        id: "s2",
        time: 2,
        type: "opaque",
        firstSeenIn: "b",
        claims: null,
        header: null,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("eyJ");
  });

  const hash = nodeDigest("sha256Hex", refreshToken);
  const row = {
    _id: "j97ezkdh6w83mzw72caq5rs71x8jy1xh",
    hash,
    sessionId: SESSION_ID,
    state: "issued",
  };

  test("links a token to the row of its hash, whichever comes first", () => {
    for (const order of ["token first", "row first"]) {
      const raw: string[] = [];
      const secrets = new Secrets(config, nodeDigest, (value) =>
        raw.push(value),
      );
      const see = () => secrets.ref(refreshToken, 10, "e");
      const observe = () =>
        secrets.observeDocument("auth", "refreshTokens", row._id, row, 5);
      if (order === "token first") {
        see();
        observe();
      } else {
        observe();
        see();
      }
      const links = secrets
        .drain()
        .filter((event) => event.kind === "secretLink");
      expect(links).toEqual([
        {
          kind: "secretLink",
          id: `s1->auth/refreshTokens/${row._id}`,
          // The later of the two.
          time: 10,
          secret: "s1",
          component: "auth",
          table: "refreshTokens",
          documentId: row._id,
          via: "sha256Hex:hash",
        },
      ]);
      expect(raw.sort()).toEqual([hash, refreshToken].sort());
      // A later revision of the row does not link again.
      secrets.observeDocument(
        "auth",
        "refreshTokens",
        row._id,
        { ...row, state: "redeemed" },
        20,
      );
      expect(secrets.drain()).toEqual([]);
    }
  });

  test("links a JWT to the row its claim names", () => {
    const secrets = new Secrets(config, nodeDigest);
    secrets.ref(jwt, 1, "a");
    secrets.observeDocument(
      "auth",
      "sessions",
      SESSION_ID,
      { _id: SESSION_ID },
      2,
    );
    expect(
      secrets.drain().find((event) => event.kind === "secretLink"),
    ).toMatchObject({
      secret: "s1",
      table: "sessions",
      documentId: SESSION_ID,
      via: "claim:sub",
    });
  });

  test("links nothing without a project config", () => {
    const secrets = new Secrets(GENERIC_BROWSER, nodeDigest);
    secrets.ref(refreshToken, 1, "a");
    secrets.ref(jwt, 1, "a");
    secrets.observeDocument("auth", "refreshTokens", row._id, row, 2);
    secrets.observeDocument(
      "auth",
      "sessions",
      SESSION_ID,
      { _id: SESSION_ID },
      2,
    );
    const events = secrets.drain();
    expect(events.filter((event) => event.kind === "secretLink")).toEqual([]);
    // Only the numeric claims of a JWT.
    expect(events[1]).toMatchObject({
      type: "jwt",
      claims: { iat: 1000, exp: 1060 },
    });
  });
});
