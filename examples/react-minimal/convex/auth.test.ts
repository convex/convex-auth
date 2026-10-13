import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { registerAnonymousProvider } from "@convex-dev/auth/components/anonymous/test";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import { getAuthUserId } from "@convex-dev/auth/server";
import schema from "./schema.js";
import { decodeJwt } from "jose";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerAnonymousProvider(t);
  return t;
}

describe("anonymous sign in", () => {
  test("returns a token bundle in the shared sign-in envelope", async () => {
    const t = setup();
    const result = await t.mutation(api.auth.signInAnonymously, {});
    // Every sign-in method returns the same `{ status, tokens }` envelope. Fixing
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
    const t = setup();
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
    expect(await caller.run((ctx) => getAuthUserId(ctx))).toBe(tokens.userId);

    // The access token is still valid, but its session is gone.
    await t.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
    expect(await caller.run((ctx) => getAuthUserId(ctx))).toBeNull();
  });
});
