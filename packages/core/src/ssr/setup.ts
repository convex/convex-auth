/**
 * The framework-agnostic auth server factory, exported at
 * `@convex-dev/auth/ssr`.
 *
 * {@link setupConvexAuthServer} takes the shared config once (deployment URL,
 * the session mutations, the exposed sign-in functions, and the cookie
 * attributes) and returns the WHATWG `(Request) => Response` handlers a
 * framework mounts as routes: refresh, sign-out, and the `convexProxyHandler`
 * that serves every sign-in method.
 *
 * The whole surface shares one {@link AuthCookieOptions}, so `secure` is decided
 * exactly once per integration and reaches every handler, including sign-in.
 *
 * @module
 */

import type { RefreshSessionFn, SignOutFn } from "../lib/types.ts";
import type { AuthCookieOptions } from "./cookies.ts";
import { refreshHandler, signOutHandler } from "./handlers.ts";
import { convexProxyHandler, type ExposedSignInFn } from "./signInProxy.ts";

/** Configuration for {@link setupConvexAuthServer}. */
export interface ConvexAuthServerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. */
  refreshSession: RefreshSessionFn;
  /** The app's `signOut` mutation reference. */
  signOut: SignOutFn;
  /**
   * The provider sign-in functions to expose through the auth proxy.
   * This should include all the Convex backend functions in your app that can issue auth sessions (e.g. account creation, log in with existing account…).
   *
   * Anything not listed is refused, so this allowlist is the proxy's entire API
   * surface. Listing a function here is all the wiring an auth method needs.
   */
  signIn: ExposedSignInFn[];
  /** Auth cookie attributes for every handler; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by every handler's CSRF
   * origin check, for deployments where the two differ (e.g. a proxy that
   * rewrites `Host`). See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
}

/**
 * Configure the auth handlers once and get back the routes to mount.
 *
 * ```ts
 * // auth.ts
 * export const auth = setupConvexAuthServer({
 *   convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
 *   refreshSession: api.auth.refreshSession,
 *   signOut: api.auth.signOut,
 *   signIn: [api.auth.signInAnonymously, api.auth.signInWithUsernamePassword],
 *   cookieOptions: { secure: process.env.NODE_ENV === "production" },
 * });
 * ```
 *
 * Then mount the routes that it returns. For example, the sign-in route
 * serves every method listed in `signIn`:
 *
 * ```ts
 * // app/auth/signin/route.ts
 * import { auth } from "@/auth"; // the result of `setupConvexAuthServer`
 *
 * export const POST = auth.convexProxyHandler;
 * ```
 */
export function setupConvexAuthServer(config: ConvexAuthServerConfig) {
  const { convexUrl, cookieOptions, allowedOrigins } = config;
  return {
    refreshHandler: refreshHandler({
      convexUrl,
      refreshSession: config.refreshSession,
      cookieOptions,
      allowedOrigins,
    }),
    signOutHandler: signOutHandler({
      convexUrl,
      signOut: config.signOut,
      cookieOptions,
      allowedOrigins,
    }),
    /**
     * The sign-in route.
     *
     * Mount it once, at a static path, and every function in `signIn` is
     * reachable from its provider's normal client hook.
     *
     * ```ts
     * // app/auth/signin/route.ts
     * import { auth } from "@/auth"; // the result of `setupConvexAuthServer`
     *
     * export const POST = auth.convexProxyHandler;
     * ```
     */
    convexProxyHandler: convexProxyHandler({
      convexUrl,
      signIn: config.signIn,
      cookieOptions,
      allowedOrigins,
    }),
  };
}
