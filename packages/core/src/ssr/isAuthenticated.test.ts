import { beforeEach, describe, expect, test, vi } from "vitest";
import { createServerAuthChecker } from "./isAuthenticated.ts";

// The checker verifies tokens through a `ConvexHttpClient`; stub it so the
// tests exercise the gate/verify logic without a backend.
const { isAuthenticatedQueryMock, setAuthMock } = vi.hoisted(() => ({
  isAuthenticatedQueryMock: vi.fn(),
  setAuthMock: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth = setAuthMock;
    query = isAuthenticatedQueryMock;
  },
}));

/** Build an unsigned JWT whose payload has the given `exp` (seconds). */
function jwt(expSeconds: number): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sub: "user-1", exp: expSeconds })}.sig`;
}

// Pin "now" so token-expiry math is deterministic.
const NOW = 1_000_000; // seconds
const nowMs = NOW * 1000;

// A placeholder query reference; the mocked client ignores its shape.
const fnRef = {} as never;
const newChecker = () =>
  createServerAuthChecker({
    convexUrl: "https://x.convex.cloud",
    isAuthenticated: fnRef,
  });

beforeEach(() => {
  isAuthenticatedQueryMock.mockReset();
  setAuthMock.mockReset();
});

describe("createServerAuthChecker", () => {
  test("a null token is unauthenticated without a round trip", async () => {
    const isAuthenticated = newChecker();
    expect(await isAuthenticated(null)).toBe(false);
    expect(isAuthenticatedQueryMock).not.toHaveBeenCalled();
  });

  test("an expired token is rejected by the local gate without a round trip", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const isAuthenticated = newChecker();
    expect(await isAuthenticated(jwt(NOW - 1))).toBe(false);
    expect(isAuthenticatedQueryMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("a non-expired token is verified against the backend, which accepts it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    isAuthenticatedQueryMock.mockResolvedValue(true);
    const token = jwt(NOW + 60);
    const isAuthenticated = newChecker();

    expect(await isAuthenticated(token)).toBe(true);
    // The token is presented to the backend for signature verification.
    expect(setAuthMock).toHaveBeenCalledWith(token);
    expect(isAuthenticatedQueryMock).toHaveBeenCalledWith(fnRef, {});
    vi.restoreAllMocks();
  });

  test("a forged token with a future exp is rejected by the backend", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    // The local gate passes it (future exp), but the backend rejects the
    // signature, so the verdict is false.
    isAuthenticatedQueryMock.mockResolvedValue(false);
    const isAuthenticated = newChecker();

    expect(await isAuthenticated(jwt(NOW + 60))).toBe(false);
    expect(isAuthenticatedQueryMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  test("fails closed to false when the backend errors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    isAuthenticatedQueryMock.mockRejectedValue(new Error("network down"));
    const isAuthenticated = newChecker();

    expect(await isAuthenticated(jwt(NOW + 60))).toBe(false);
    vi.restoreAllMocks();
  });
});
