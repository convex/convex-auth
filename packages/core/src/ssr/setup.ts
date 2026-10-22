/**
 * The framework-agnostic auth server factory, exported at
 * `@convex-dev/auth/ssr`.
 *
 * {@link setupConvexAuthServer} takes the shared config once (deployment URL,
 * the session mutations, the exposed sign-in functions, and the cookie
 * attributes) and returns the WHATWG `(Request) => Response` handlers a
 * framework mounts as routes: refresh, sign-out, and the `convexProxyHandler`
 * that serves every sign-in method. It also returns `handler`, which serves
 * all three from one dynamic route by dispatching on the last path segment.
 *
 * The whole surface shares one {@link AuthCookieOptions}, so `secure` is decided
 * exactly once per integration and reaches every handler, including sign-in.
 *
 * @module
 */

import type { RefreshSessionFn, SignOutFn } from "../lib/types.ts";
import type { AuthCookieOptions } from "./cookies.ts";
import {
  refreshHandler,
  signOutHandler,
  type RequestHandler,
} from "./handlers.ts";
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
 * Then mount the routes that it returns. With a framework that has dynamic
 * route segments, one file serves all three:
 *
 * ```ts
 * // app/auth/[route]/route.ts
 * import { auth } from "@/auth"; // the result of `setupConvexAuthServer`
 *
 * export const POST = auth.handler;
 * ```
 *
 * Or mount each handler at its own path, e.g. the sign-in route, which serves
 * every method listed in `signIn`:
 *
 * ```ts
 * // app/auth/signin/route.ts
 * export const POST = auth.convexProxyHandler;
 * ```
 */
export function setupConvexAuthServer(config: ConvexAuthServerConfig) {
  const { convexUrl, cookieOptions, allowedOrigins } = config;
  const handlers = {
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
  // The client posts to `<base>/signin`, `<base>/refresh` and `<base>/signout`,
  // so the last segment names the handler wherever the base is mounted.
  const byRoute: Record<string, RequestHandler> = {
    signin: handlers.convexProxyHandler,
    refresh: handlers.refreshHandler,
    signout: handlers.signOutHandler,
  };
  return {
    ...handlers,
    /**
     * All three routes in one handler, for a dynamic route segment. It
     * dispatches on the last path segment (`signin`, `refresh` or `signout`)
     * and answers 404 to anything else.
     *
     * ```ts
     * // app/auth/[route]/route.ts
     * import { auth } from "@/auth"; // the result of `setupConvexAuthServer`
     *
     * export const POST = auth.handler;
     * ```
     */
    handler: (async (request) => {
      const route = new URL(request.url).pathname
        .replace(/\/+$/, "")
        .split("/")
        .pop();
      const handler = route === undefined ? undefined : byRoute[route];
      return handler !== undefined
        ? handler(request)
        : new Response(null, { status: 404 });
    }) satisfies RequestHandler,
  };
}
