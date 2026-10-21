import { describe, expect, test, vi } from "vitest";
import type { RefreshResult, TokenBundle } from "../lib/types.ts";
import {
  AuthCookieOptions,
  CookieDeleteOptions,
  CookieOptions,
  CookieStore,
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
} from "./cookies.ts";
import { RefreshSession, ServerAuthSession } from "./session.ts";

/** Build an unsigned JWT whose payload has the given `exp` (seconds). `jose`'s
 * `decodeJwt` reads the payload without verifying the signature. */
function jwt(expSeconds: number, sub = "user-1"): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub, exp: expSeconds })}.sig`;
}

// Pin "now" so token-expiry math is deterministic.
const NOW = 1_000_000; // seconds
const nowMs = NOW * 1000;

function newTokenBundle(
  n: number,
  accessTtlSeconds = 60,
  refreshTtlSeconds = 60 * 60 * 24 * 30,
): TokenBundle {
  return {
    accessToken: jwt(NOW + accessTtlSeconds),
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: nowMs + refreshTtlSeconds * 1000,
    userId: "user-1",
  };
}

/** An in-memory {@link CookieStore} that also records the options each cookie
 * was written or deleted with, so tests can assert httpOnly, path, etc. */
class FakeCookies implements CookieStore {
  values = new Map<string, string>();
  options = new Map<string, CookieOptions | undefined>();
  deletions = new Map<string, CookieDeleteOptions | undefined>();
  get(name: string) {
    return this.values.get(name);
  }
  set(name: string, value: string, options?: CookieOptions) {
    this.values.set(name, value);
    this.options.set(name, options);
  }
  delete(name: string, options?: CookieDeleteOptions) {
    this.values.delete(name);
    this.options.delete(name);
    this.deletions.set(name, options);
  }
}

/** A `rotated` refresh outcome carrying `bundle`. */
function rotated(bundle: TokenBundle): RefreshResult {
  return { kind: "rotated", tokens: bundle };
}

function newSession(
  refreshSession: RefreshSession = async () => ({ kind: "noSession" }),
  cookies = new FakeCookies(),
  cookieOptions: AuthCookieOptions = { secure: false },
) {
  const session = new ServerAuthSession({
    refreshSession,
    cookies,
    cookieOptions,
  });
  return { session, cookies };
}

describe("ServerAuthSession", () => {
  test("getToken returns a comfortably-valid cookie token without refreshing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const refreshSession = vi.fn(async () => rotated(newTokenBundle(2)));
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 60));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(refreshSession, cookies);

    expect(await session.getToken()).toBe(jwt(NOW + 60));
    expect(refreshSession).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("getToken refreshes a near-expiry token and rewrites both cookies", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const next = newTokenBundle(2);
    const refreshSession = vi.fn(async (rt: string) => {
      expect(rt).toBe("refresh-1");
      return rotated(next);
    });
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5)); // within the 10s skew
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(refreshSession, cookies);

    expect(await session.getToken()).toBe(next.accessToken);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(cookies.get(AUTH_JWT_COOKIE)).toBe(next.accessToken);
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBe("refresh-2");
    expect(cookies.options.get(AUTH_REFRESH_COOKIE)?.httpOnly).toBe(true);
    vi.restoreAllMocks();
  });

  test("getToken refreshes when the JWT cookie is missing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const refreshSession = vi.fn(async () => rotated(newTokenBundle(2)));
    const cookies = new FakeCookies();
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(refreshSession, cookies);

    expect(await session.getToken()).toBe(newTokenBundle(2).accessToken);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  test("a noSession refresh clears both cookies and yields no token", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(
      async () => ({ kind: "noSession" }),
      cookies,
    );

    expect(await session.getToken()).toBeNull();
    expect(cookies.get(AUTH_JWT_COOKIE)).toBeUndefined();
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBeUndefined();
    vi.restoreAllMocks();
  });

  test("clearing on a failed refresh deletes with the configured path and domain", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(
      async () => ({ kind: "noSession" }),
      cookies,
      {
        secure: false,
        path: "/app",
        domain: "example.com",
      },
    );

    expect(await session.getToken()).toBeNull();
    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE]) {
      expect(cookies.deletions.get(name)).toEqual({
        path: "/app",
        domain: "example.com",
      });
    }
    vi.restoreAllMocks();
  });

  test("getToken returns null when there is no refresh cookie", async () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const refreshSession = vi.fn(async () => rotated(newTokenBundle(2)));
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5)); // expiring, and nothing to refresh with
    const { session } = newSession(refreshSession, cookies);

    expect(await session.getToken()).toBeNull();
    expect(refreshSession).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test("setTokens writes both cookies httpOnly", async () => {
    const cookies = new FakeCookies();
    const { session } = newSession(undefined, cookies);
    await session.setTokens(newTokenBundle(1));

    expect(cookies.get(AUTH_JWT_COOKIE)).toBe(newTokenBundle(1).accessToken);
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBe("refresh-1");
    expect(cookies.options.get(AUTH_JWT_COOKIE)?.httpOnly).toBe(true);
    expect(cookies.options.get(AUTH_REFRESH_COOKIE)?.httpOnly).toBe(true);
  });
});
