/**
 * Framework-agnostic `(Request) => Response` auth handlers.
 *
 * These are the method-*agnostic* halves of the SSR auth surface. This
 * module exposes plain WHATWG handlers an application mounts at routes of its
 * choosing (e.g. `/auth/refresh`, `/auth/signout`). They read the httpOnly
 * refresh-token cookie from the request and reply with the access-only {@link
 * SlimTokenBundle} the browser is allowed to hold. The refresh token stays in
 * the cookie and never reaches the response body.
 *
 * Each handler takes only the one mutation reference it calls:
 * `refreshHandler` the app's `refreshSession`, `signOutHandler` its `signOut`.
 *
 * Both refuse cross-site requests up front (403, before any Convex call or
 * cookie write) by checking the `Origin` header via {@link isTrustedOrigin}.
 *
 * Sign-in has no counterpart here: it goes through the auth proxy (see
 * `./proxy`), which needs no per-method server code.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import type {
  AuthSessionResponse,
  RefreshSessionFn,
  SignOutFn,
} from "../lib/types.ts";
import { makeSlimBundle } from "../lib/types.ts";
import {
  AUTH_REFRESH_COOKIE,
  AuthCookieOptions,
  clearAuthCookies,
} from "./cookies.ts";
import { httpCookies } from "./httpCookies.ts";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin.ts";
import { ServerAuthSession } from "./session.ts";

/** A WHATWG request handler. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** Configuration for {@link refreshHandler}. */
export interface RefreshHandlerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. */
  refreshSession: RefreshSessionFn;
  /** Auth cookie attributes; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by the CSRF origin
   * check, for deployments where the two differ (e.g. a proxy that rewrites
   * `Host`). See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
}

/**
 * A handler that refreshes the session from the httpOnly refresh-token cookie,
 * replying with an {@link AuthSessionResponse} carrying the fresh access token.
 * When there is no session left (missing or unrecognized refresh cookie) it
 * replies 401 with `tokens: null`.
 */
export function refreshHandler(config: RefreshHandlerConfig): RequestHandler {
  const client = new ConvexHttpClient(config.convexUrl);
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) {
      return forbiddenOriginResponse();
    }
    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) =>
        client.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions: config.cookieOptions,
    });
    const result = await session.refresh();
    const res =
      result.kind === "noSession"
        ? Response.json({ tokens: null } satisfies AuthSessionResponse, {
            status: 401,
          })
        : Response.json({
            tokens: makeSlimBundle(result.tokens),
          } satisfies AuthSessionResponse);
    cookies.applyTo(res.headers);
    return res;
  };
}

/** Configuration for {@link signOutHandler}. */
export interface SignOutHandlerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `signOut` mutation reference. */
  signOut: SignOutFn;
  /** Auth cookie attributes; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by the CSRF origin
   * check, for deployments where the two differ (e.g. a proxy that rewrites
   * `Host`). See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
}

/**
 * A handler that revokes the session from the httpOnly refresh-token cookie
 * (best effort) and clears both cookies, replying with an
 * {@link AuthSessionResponse} carrying `tokens: null`.
 */
export function signOutHandler(config: SignOutHandlerConfig): RequestHandler {
  const client = new ConvexHttpClient(config.convexUrl);
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) {
      return forbiddenOriginResponse();
    }
    const cookies = httpCookies(request);
    const refreshToken = (await cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken !== null) {
      try {
        await client.mutation(config.signOut, { refreshToken });
      } catch {
        // Usually means we were already signed out, which is fine.
      }
    }
    await clearAuthCookies(cookies, config.cookieOptions);
    const res = Response.json({ tokens: null } satisfies AuthSessionResponse);
    cookies.applyTo(res.headers);
    return res;
  };
}
