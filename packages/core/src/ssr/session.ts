/**
 * The framework-agnostic owner of an auth session on the server (SSR).
 *
 * Whereas SPA clients keep the session tokens in `localStorage` and accesses
 * the refresh token in client JS, an SSR client and host exchange the tokens
 * via cookies. This code orchestrates reading those cookies, refreshing the
 * access token against the server when it is missing or near expiry, and
 * writing the rotated tokens back as cookies.
 *
 * The {@link ServerAuthSessionConfig} class takes an injected `refreshSession`
 * callback, so it never imports Convex: a framework binding supplies one on
 * top of an HTTP client and a {@link CookieStore} built on its
 * request/response cookies, and tests supply a fake. The SSR host accesses the
 * refresh token (from the cookie), passes it in a refresh request to the
 * Convex backend and gets back a {@link RefreshResult}. It uses that to update
 * the cookie values and communicate the refreshed access token to the client.
 *
 * Which cookies get written depends on the outcome; see
 * {@link ServerAuthSession.refresh}.
 *
 * @module
 */

import type { RefreshResult, TokenBundle } from "../lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  AuthCookieOptions,
  CookieStore,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies.ts";
import { isTokenExpiring } from "./jwt.ts";

/**
 * Exchange a refresh token for a fresh session, resolving to one of the
 * {@link RefreshResult} outcomes. A framework binding usually implements this
 * over a Convex HTTP client; tests pass a fake.
 */
export type RefreshSession = (refreshToken: string) => Promise<RefreshResult>;

/** Configuration for a {@link ServerAuthSession}. */
export interface ServerAuthSessionConfig {
  /** Exchange the cookie's refresh token for a fresh session (typically over a
   * Convex HTTP client). */
  refreshSession: RefreshSession;
  /** Request/response cookies for this SSR request. */
  cookies: CookieStore;
  /**
   * Seconds before access-token expiry at which {@link ServerAuthSession.getToken}
   * proactively refreshes. Defaults to 10.
   */
  refreshSkewSeconds?: number;
  /**
   * Base cookie attributes. Per-cookie lifetime is derived from the token
   * bundle. `secure` is required (see {@link AuthCookieOptions}).
   */
  cookieOptions: AuthCookieOptions;
}

export class ServerAuthSession {
  readonly #refreshSession: RefreshSession;
  readonly #cookies: CookieStore;
  readonly #refreshSkewSeconds: number;
  readonly #cookieOptions: AuthCookieOptions;

  constructor(config: ServerAuthSessionConfig) {
    this.#refreshSession = config.refreshSession;
    this.#cookies = config.cookies;
    this.#refreshSkewSeconds = config.refreshSkewSeconds ?? 10;
    this.#cookieOptions = config.cookieOptions;
  }

  /**
   * The access token to authenticate SSR requests with. Returns the cookie's
   * token when it is still comfortably valid; otherwise refreshes (rotating the
   * refresh token and rewriting both cookies). `null` means no usable session.
   */
  async getToken(): Promise<string | null> {
    const token = (await this.#cookies.get(AUTH_JWT_COOKIE)) ?? null;
    if (token !== null && !isTokenExpiring(token, this.#refreshSkewSeconds)) {
      return token;
    }
    const result = await this.refresh();
    return result.kind === "rotated" ? result.tokens.accessToken : null;
  }

  /**
   * Force a refresh from the refresh-token cookie, updating the cookies to match
   * the outcome:
   *
   *  * `rotated`: rewrite both cookies with the new bundle.
   *  * `noSession`: clear both.
   */
  async refresh(): Promise<RefreshResult> {
    const refreshToken = (await this.#cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken === null) {
      return { kind: "noSession" };
    }
    const result = await this.#refreshSession(refreshToken);
    switch (result.kind) {
      case "rotated":
        await this.setTokens(result.tokens);
        break;
      case "noSession":
        await this.#clear();
        break;
    }
    return result;
  }

  /**
   * Persist a token bundle as cookies. Used after a sign-in whose bundle was
   * minted elsewhere (e.g. a client-side sign-in flow) to move the refresh token
   * into the httpOnly cookie. Both cookies live as long as the refresh token;
   * the access token is refreshed on expiry via {@link getToken}.
   */
  async setTokens(bundle: TokenBundle): Promise<void> {
    await writeAuthCookies(this.#cookies, bundle, this.#cookieOptions);
  }

  /** Deletes the cookies. This will be reflected in the eventual response. */
  async #clear(): Promise<void> {
    await clearAuthCookies(this.#cookies, this.#cookieOptions);
  }
}
