import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { registerAnonymousProvider } from "@convex-dev/auth/components/anonymous/test";
import { registerCore } from "@convex-dev/auth/test";
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
    const t = setup();
    const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
    const jwt = decodeJwt(tokens.accessToken);
    expect(jwt.sub).toBe(tokens.userId);
  });
});
