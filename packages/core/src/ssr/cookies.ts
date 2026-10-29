/**
 * A framework-agnostic cookie abstraction for server-side (SSR) auth.
 *
 * SSR frameworks each expose cookies differently — Next.js has `NextRequest`/
 * `NextResponse` cookies in the proxy and `next/headers` `cookies()` in route
 * handlers and server components; other frameworks have their own. This module
 * defines the small interface the shared {@link ServerAuthSession} needs, so a
 * framework binding only has to adapt its cookies to {@link CookieStore}.
 *
 * Nothing here depends on React, Next.js, or Convex.
 *
 * @module
 */

import {
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "../browser/storage.ts";
import type { TokenBundle } from "../lib/types.ts";

/** The cookie holding the current access token (a JWT). */
export const AUTH_JWT_COOKIE = JWT_STORAGE_KEY;
/** The cookie holding the current (rotating) refresh token. */
export const AUTH_REFRESH_COOKIE = REFRESH_TOKEN_STORAGE_KEY;

/** Attributes applied when writing a cookie. The low-level shape, all optional. */
export interface CookieOptions {
  /** Whether to hide the cookie from client JS. */
  httpOnly?: boolean;
  /** Whether to send only over HTTPS. */
  secure?: boolean;
  /** CSRF posture. Defaults to `"lax"`. */
  sameSite?: "lax" | "strict" | "none";
  /** Cookie path. Defaults to `"/"`. */
  path?: string;
  /** Max age in seconds. */
  maxAge?: number;
  /** Absolute expiry. */
  expires?: Date;
  /** Cookie domain. */
  domain?: string;
}

/**
 * The attributes that identify which cookie a deletion targets: browsers only
 * remove a cookie when the deletion's `path` and `domain` match the ones it
 * was written with. No other attribute takes part in matching.
 */
export type CookieDeleteOptions = Pick<CookieOptions, "path" | "domain">;

/**
 * The cookie options a framework integration may supply for auth cookies:
 * only the attributes that legitimately vary by deployment.
 *
 * `secure` is required. Whether auth cookies are HTTPS-only depends on the
 * deployment (HTTPS in production, plain http on localhost), so every
 * integration has to decide it explicitly rather than inherit a default that
 * would be wrong in one environment or the other.
 *
 * The security-relevant attributes (`httpOnly`, `sameSite`) and the token
 * lifetimes (`maxAge`, `expires`, which derive from the token bundle) are
 * deliberately not configurable; {@link writeAuthCookies} always applies the
 * invariant values.
 */
export type AuthCookieOptions = CookieDeleteOptions & {
  secure: boolean;
};

/**
 * Read/write/delete cookies. Every method may be synchronous or return a
 * promise, so request/response cookie APIs that are async (e.g. `next/headers`
 * `cookies()`) work without ceremony.
 */
export interface CookieStore {
  /** Read a cookie value. */
  get: (name: string) => string | undefined | Promise<string | undefined>;
  /** Write a cookie. */
  set: (
    name: string,
    value: string,
    options?: CookieOptions,
  ) => void | Promise<void>;
  /** Delete a cookie. Must be given the same `path`/`domain` the cookie was
   * written with, or the deletion won't match it. */
  delete: (name: string, options?: CookieDeleteOptions) => void | Promise<void>;
}

/**
 * The environment-independent attributes for auth cookies, merged under any
 * caller-supplied options by {@link writeAuthCookies}.
 *
 *  * `httpOnly: true` (so the refresh token never reaches client JS)
 *  * `sameSite: "lax"` to aid in CSRF protection (see
 *     https://auth.pilcrowonpaper.com/csrf)
 *  * `path: "/"` so the cookies will be sent for all paths on the site
 *
 * `secure` is deliberately absent: it varies by environment and is supplied by
 * the caller via {@link AuthCookieOptions}.
 */
function invariantCookieOptions(): Omit<CookieOptions, "secure"> {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  };
}

/**
 * The attributes an auth cookie is written with: the invariant ones merged under
 * the deployment-specific ones, and a lifetime taken from the refresh token's
 * expiry. Both cookies live that long; the access token expires sooner and gets
 * refreshed via {@link ServerAuthSession.getToken}.
 */
function authCookieOptions(
  refreshTokenExpiresAt: number,
  options: AuthCookieOptions,
): CookieOptions {
  // Pick the allowed fields rather than spreading, so a wider object
  // (e.g. from untyped JS) cannot override the invariant attributes.
  return {
    ...invariantCookieOptions(),
    path: options.path ?? "/",
    domain: options.domain,
    secure: options.secure,
    expires: new Date(refreshTokenExpiresAt),
  };
}

/**
 * Write the tokens in a `bundle` as cookies.
 *
 * The access token is stored in {@link AUTH_JWT_COOKIE} and the refresh token
 * in {@link AUTH_REFRESH_COOKIE}. The invariant attributes (httpOnly etc.) are
 * merged in, so the refresh cookie is httpOnly and never reaches client JS.
 *
 * This is the one place that knows which cookies hold a session, so refresh,
 * the proxy, and every method's sign-in handler write cookies identically.
 */
export async function writeAuthCookies(
  cookies: CookieStore,
  bundle: TokenBundle,
  options: AuthCookieOptions,
): Promise<void> {
  const attributes = authCookieOptions(bundle.refreshTokenExpiresAt, options);
  await cookies.set(AUTH_JWT_COOKIE, bundle.accessToken, attributes);
  await cookies.set(AUTH_REFRESH_COOKIE, bundle.refreshToken, attributes);
}

/**
 * Delete both auth cookies. The counterpart of {@link writeAuthCookies}: it
 * takes the same options so the deletions match the cookies the writes
 * produced (a deletion only removes a cookie whose `path`/`domain` match).
 */
export async function clearAuthCookies(
  cookies: CookieStore,
  options: AuthCookieOptions,
): Promise<void> {
  // Mirror writeAuthCookies' merge, where path defaults to "/".
  const { path = "/", domain } = options;
  await cookies.delete(AUTH_JWT_COOKIE, { path, domain });
  await cookies.delete(AUTH_REFRESH_COOKIE, { path, domain });
}
