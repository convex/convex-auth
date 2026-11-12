import { convexTest } from "convex-test";
import { defineSchema } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  assertMountedAsCore,
  componentPathFromIssuer,
} from "./coreComponent.ts";

const CLOUD_URL = "https://some-deployment.convex.cloud";

/**
 * Make a JWT with the given issuer. The signature is not valid:
 * `assertMountedAsCore` reads the issuer and does not check the signature.
 */
function tokenWithIssuer(issuer: string): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ iss: issuer, aud: "test" });
  return `${header}.${payload}.signature`;
}

describe("assertMountedAsCore", () => {
  test("accepts a token that the core signed at `auth`", () => {
    const token = tokenWithIssuer(`${CLOUD_URL}/components/auth`);
    expect(() => assertMountedAsCore(token)).not.toThrow();
  });

  test("throws for a core mounted at a different path", () => {
    const token = tokenWithIssuer(`${CLOUD_URL}/components/myAuth`);
    expect(() => assertMountedAsCore(token)).toThrow(
      'The auth component is mounted at "myAuth", but it must be mounted at "auth".',
    );
  });

  test("accepts a token that the app signed, as in tests of the core", async () => {
    const t = convexTest(defineSchema({}), {
      "./_generated/api.ts": async () => ({}),
    });
    const token = await t.run(
      async (ctx) =>
        await ctx.auth.signJwt({
          claims: { aud: "test" },
          expiresInSeconds: 1,
        }),
    );
    expect(() => assertMountedAsCore(token)).not.toThrow();
  });
});

describe("componentPathFromIssuer", () => {
  test("returns the path of a component issuer", () => {
    expect(componentPathFromIssuer(`${CLOUD_URL}/components/auth`)).toBe(
      "auth",
    );
    expect(
      componentPathFromIssuer(`${CLOUD_URL}/components/parent/authPassword`),
    ).toBe("parent/authPassword");
  });

  test("returns null for the app, another deployment, or no issuer", () => {
    expect(componentPathFromIssuer(CLOUD_URL)).toBeNull();
    expect(componentPathFromIssuer(`${CLOUD_URL}/components/`)).toBeNull();
    expect(
      componentPathFromIssuer("https://other.convex.cloud/components/auth"),
    ).toBeNull();
    expect(componentPathFromIssuer(undefined)).toBeNull();
  });
});
