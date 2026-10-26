import { describe, expect, test } from "vitest";
import type { TokenBundle } from "../lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  AuthCookieOptions,
  CookieDeleteOptions,
  CookieOptions,
  CookieStore,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies.ts";

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 2_000_000,
  userId: "user-1",
};

class FakeCookies implements CookieStore {
  writes = new Map<string, CookieOptions | undefined>();
  deletions = new Map<string, CookieDeleteOptions | undefined>();
  get() {
    return undefined;
  }
  set(name: string, _value: string, options?: CookieOptions) {
    this.writes.set(name, options);
  }
  delete(name: string, options?: CookieDeleteOptions) {
    this.deletions.set(name, options);
  }
}

describe("writeAuthCookies", () => {
  test("applies the invariant attributes and the caller's options", async () => {
    const cookies = new FakeCookies();
    await writeAuthCookies(cookies, bundle, {
      secure: true,
      path: "/app",
      domain: "example.com",
    });

    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE]) {
      expect(cookies.writes.get(name)).toEqual({
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        path: "/app",
        domain: "example.com",
        expires: new Date(bundle.refreshTokenExpiresAt),
      });
    }
  });

  test("a wider options object cannot override the invariants", async () => {
    const cookies = new FakeCookies();
    // Simulate an untyped JS caller passing disallowed attributes.
    const hostile = {
      secure: false,
      httpOnly: false,
      sameSite: "none",
      maxAge: 5,
      expires: new Date(0),
    } as AuthCookieOptions;
    await writeAuthCookies(cookies, bundle, hostile);

    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE]) {
      const written = cookies.writes.get(name)!;
      expect(written.httpOnly).toBe(true);
      expect(written.sameSite).toBe("lax");
      expect(written.maxAge).toBeUndefined();
      expect(written.expires).toEqual(new Date(bundle.refreshTokenExpiresAt));
    }
  });
});

describe("clearAuthCookies", () => {
  test("deletes both cookies with the configured path and domain", async () => {
    const cookies = new FakeCookies();
    await clearAuthCookies(cookies, {
      secure: true,
      path: "/app",
      domain: "example.com",
    });

    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE]) {
      expect(cookies.deletions.get(name)).toEqual({
        path: "/app",
        domain: "example.com",
      });
    }
  });

  test("path defaults to / to match the write-side default", async () => {
    const cookies = new FakeCookies();
    await clearAuthCookies(cookies, { secure: true });
    expect(cookies.deletions.get(AUTH_JWT_COOKIE)).toEqual({
      path: "/",
      domain: undefined,
    });
  });
});
