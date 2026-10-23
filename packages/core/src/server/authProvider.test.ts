import { afterEach, describe, expect, test, vi } from "vitest";
import { convexAuthProvider } from "./authProvider.ts";

describe("convexAuthProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("trusts the tokens the auth component mints", () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    expect(convexAuthProvider()).toEqual({
      type: "customJwt",
      applicationID: "convex",
      issuer: "https://happy-otter-123.convex.cloud/components/auth",
      jwks: "https://happy-otter-123.convex.cloud/.well-known/jwks.json",
      algorithm: "ES256",
    });
  });

  test("names the component the app mounts the auth component under", () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    expect(convexAuthProvider({ componentName: "myAuth" })).toMatchObject({
      issuer: "https://happy-otter-123.convex.cloud/components/myAuth",
      jwks: "https://happy-otter-123.convex.cloud/.well-known/jwks.json",
    });
  });

  test("throws without CONVEX_CLOUD_URL", () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "");
    expect(() => convexAuthProvider()).toThrow("CONVEX_CLOUD_URL");
  });
});
