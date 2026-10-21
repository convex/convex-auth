import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../lib/types.ts";
import { AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE } from "./cookies.ts";
import { refreshHandler, signOutHandler } from "./handlers.ts";

// The handlers talk to Convex through a `ConvexHttpClient`; stub it so the
// tests exercise cookie behavior without a backend. This mutation mock stands
// in for the refresh or sign-out mutations, depending on the test case.
const { mutationMock } = vi.hoisted(() => ({ mutationMock: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mutationMock;
  },
}));

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 2_000,
    userId: "user-1",
  };
}

// Same-origin by default: the CSRF guard refuses any request whose Origin
// doesn't match the Host, so a matching pair is the precondition for reaching
// the handler logic under test. Cross-site tests override both headers.
const requestWithRefresh = (token?: string, headers?: Record<string, string>) =>
  new Request("https://app.test/auth/refresh", {
    method: "POST",
    headers: {
      origin: "https://app.test",
      host: "app.test",
      ...(token ? { cookie: `${AUTH_REFRESH_COOKIE}=${token}` } : {}),
      ...headers,
    },
  });

// A placeholder function reference; the mocked client ignores it.
const fnRef = {} as never;

beforeEach(() => mutationMock.mockReset());

describe("refreshHandler", () => {
  test("rotates the session and returns access-only tokens", async () => {
    // Set up the refresh mutation to return new tokens.
    mutationMock.mockResolvedValue({ kind: "rotated", tokens: bundle(2) });
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Access-only: no refresh token in the response body.
    expect(body.tokens).toEqual({
      accessToken: "access-2",
      userId: "user-1",
    });
    expect(body.tokens).not.toHaveProperty("refreshToken");
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-1",
    });

    // Both cookies rewritten, both cookie httpOnly.
    const setCookies = res.headers.getSetCookie();
    const jwt = setCookies.find((c) => c.startsWith(`${AUTH_JWT_COOKIE}=`));
    const refresh = setCookies.find((c) =>
      c.startsWith(`${AUTH_REFRESH_COOKIE}=`),
    );
    expect(jwt).toContain("access-2");
    expect(jwt).toContain("HttpOnly");
    expect(refresh).toContain("refresh-2");
    expect(refresh).toContain("HttpOnly");
  });

  test("with no refresh cookie replies 401 without calling Convex", async () => {
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh());
    expect(res.status).toBe(401);
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
  });

  test("replies 401 and clears cookies when the refresh token is unknown", async () => {
    // Set up the refresh mutation to not recognize the token.
    mutationMock.mockResolvedValue({ kind: "noSession" });
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("stale"));
    expect(res.status).toBe(401);
    expect((await res.json()).tokens).toBeNull();
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("signOutHandler", () => {
  test("revokes and clears both cookies", async () => {
    mutationMock.mockResolvedValue(null);
    const handler = signOutHandler({
      convexUrl: "https://x.convex.cloud",
      signOut: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1"));
    expect(res.status).toBe(200);
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-1",
    });

    const setCookies = res.headers.getSetCookie();
    expect(
      setCookies.filter((c) => c.includes("Max-Age=0")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("with no refresh cookie clears without calling Convex", async () => {
    const handler = signOutHandler({
      convexUrl: "https://x.convex.cloud",
      signOut: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh());
    expect(res.status).toBe(200);
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
    const setCookies = res.headers.getSetCookie();
    expect(
      setCookies.filter((c) => c.includes("Max-Age=0")).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

// CSRF: both handlers must refuse a cross-site request before touching Convex
// or the cookies. Sign-out is the interesting victim — it clears cookies
// unconditionally, so without the guard a cross-site POST could force-logout.
describe("cross-site requests", () => {
  const crossSite = { origin: "https://evil.test", host: "app.test" };
  const sameSite = { origin: "https://app.test", host: "app.test" };

  test("refreshHandler refuses without calling Convex or writing cookies", async () => {
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1", crossSite));
    expect(res.status).toBe(403);
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("signOutHandler refuses without revoking or clearing cookies", async () => {
    const handler = signOutHandler({
      convexUrl: "https://x.convex.cloud",
      signOut: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1", crossSite));
    expect(res.status).toBe(403);
    expect(mutationMock).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("a same-site Origin is served", async () => {
    mutationMock.mockResolvedValue({ kind: "rotated", tokens: bundle(2) });
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1", sameSite));
    expect(res.status).toBe(200);
    expect((await res.json()).tokens).not.toBeNull();
  });

  test("allowedOrigins admits a cross-host but trusted Origin", async () => {
    mutationMock.mockResolvedValue({ kind: "rotated", tokens: bundle(2) });
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
      allowedOrigins: ["https://public.test"],
    });

    const res = await handler(
      requestWithRefresh("refresh-1", {
        origin: "https://public.test",
        host: "internal:8080",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).tokens).not.toBeNull();
  });
});
