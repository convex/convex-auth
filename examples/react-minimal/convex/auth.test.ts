import { convexTest } from "convex-test";
import { describe, expect, test, vi, afterEach } from "vitest";
import { api } from "./_generated/api.js";
import { registerAnonymousProvider } from "@convex-dev/auth/components/anonymous/test";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import schema from "./schema.js";
import { generateKeyPair, exportPKCS8, exportJWK, decodeJwt } from "jose";
import { randomUUID } from "crypto";

const modules = import.meta.glob("./**/*.ts");

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privatePem = await exportPKCS8(privateKey);
  const pubJwk = await exportJWK(publicKey);
  const kid = randomUUID();

  const authPrivateKey = Buffer.from(privatePem).toString("base64");
  const authJwks = JSON.stringify({
    keys: [{ ...pubJwk, kid, alg: "RS256", use: "sig" }],
  });

  vi.stubEnv("AUTH_PRIVATE_KEY", authPrivateKey);
  vi.stubEnv("AUTH_JWKS", authJwks);
  vi.stubEnv("CONVEX_SITE_URL", "http://localhost:8080/");
  const t = convexTest(schema, modules);
  registerCore(t);
  registerAnonymousProvider(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anonymous sign in", () => {
  test("returns a token bundle in the shared sign-in envelope", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signInAnonymously, {});
    // Every provider returns the same `{ status, tokens }` envelope. Fixing
    // where the bundle sits is what lets the SSR auth proxy find the refresh
    // token and move it into an httpOnly cookie.
    expect(result.status).toBe("complete");
    const { tokens } = result;
    expect(tokens.userId).not.toBe(null);
    expect(tokens.accessToken).not.toBe(null);
    expect(tokens.refreshToken).not.toBe(null);
    expect(tokens.refreshTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  test("returned access token is valid JWT", async () => {
    const t = await setup();
    const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
    const jwt = decodeJwt(tokens.accessToken);
    // The subject is the session, not the user.
    expect(jwt.sub).toEqual(expect.any(String));
    expect(jwt.sub).not.toBe(tokens.userId);
  });

  test("resolves the signed-in user through the session", async () => {
    const t = await setup();
    const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
    const caller = t.withIdentity(sessionIdentity(tokens));
    expect(await caller.query(api.currentUser.loggedInUser, {})).toEqual({
      id: tokens.userId,
    });

    // The access token is still valid, but its session is gone.
    await t.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
    expect(await caller.query(api.currentUser.loggedInUser, {})).toBeNull();
  });
});
