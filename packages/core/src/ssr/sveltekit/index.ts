/**
 * Server bindings for Convex Auth on SvelteKit: the counterpart of
 * `setupConvexAuthNextjs` of `@convex-dev/auth/ssr/nextjs`. The client side
 * is `@convex-dev/auth/ssr/sveltekit/client`.
 *
 * The auth routes are the same as under Next.js: call `setupConvexAuthServer`
 * from `@convex-dev/auth/ssr` and mount its three handlers as `+server.ts`
 * routes. This module adds the parts that are specific to SvelteKit: the
 * `handle` hook that refreshes the session up front (the counterpart of the
 * Next.js proxy), reading the access token, and checking whether a request
 * is signed in.
 *
 * @module
 */

import { dev } from "$app/environment";
import {
  redirect,
  type Cookies,
  type Handle,
  type RequestEvent,
} from "@sveltejs/kit";
import { ConvexHttpClient } from "convex/browser";
import { withServerConvexToken } from "convex-svelte/sveltekit/server";
import type { IsAuthenticatedFn, RefreshSessionFn } from "../../lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  type AuthCookieOptions,
  type CookieStore,
} from "../cookies.ts";
import { createServerAuthChecker } from "../isAuthenticated.ts";
import { isTokenExpiring } from "../jwt.ts";
import { ServerAuthSession } from "../session.ts";

/** The configuration of {@link setupConvexAuthSvelteKit}. */
export interface ConvexAuthSvelteKitConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /**
   * The app's `refreshSession` mutation. The hook uses it for its up-front
   * refresh.
   */
  refreshSession: RefreshSessionFn;
  /**
   * The app's `isAuthenticated` query. The server verifies the access token
   * against the backend with it, rather than trusting the cookie.
   */
  isAuthenticated: IsAuthenticatedFn;
  /**
   * Overrides the default auth cookie attributes. Use the same values as in
   * `setupConvexAuthServer`. Unlike there, `secure` may be omitted here: it
   * defaults to `true` outside of `vite dev`.
   */
  cookieOptions?: Partial<AuthCookieOptions>;
  /**
   * The paths of the auth routes, which the hook leaves alone because they
   * set their own cookies. Defaults to `/auth/signin`, `/auth/refresh` and
   * `/auth/signout`.
   */
  authRoutes?: string[];
}

/** The context handed to a {@link ConvexAuthSvelteKitHandler}. */
export interface ConvexAuthSvelteKitHandleCtx {
  /** Whether the request carries a live session, verified with the backend. */
  isAuthenticated: () => Promise<boolean>;
  /** The (possibly just refreshed) access token, or `null`. */
  getToken: () => Promise<string | null>;
}

/**
 * Inspect the request in the hook. Throw SvelteKit's `redirect()` or return a
 * `Response` to short-circuit; return nothing to render the page. Both carry
 * the cookies of a refreshed session, as does a `Response` from a later hook.
 * Don't throw `error()` here or in a later hook: SvelteKit leaves the cookies
 * off error responses, so a refreshed session would be lost. Return a
 * `Response` with the error status instead.
 */
export type ConvexAuthSvelteKitHandler = (
  event: RequestEvent,
  ctx: ConvexAuthSvelteKitHandleCtx,
) => Promise<Response | undefined | void> | Response | undefined | void;

type CookieWrite = {
  name: string;
  value: string;
  options: Parameters<Cookies["set"]>[2];
};

/**
 * A {@link CookieStore} over SvelteKit's `event.cookies`. It also records its
 * writes, for a `Response` that doesn't go through `resolve()`, where
 * SvelteKit wouldn't add them.
 */
function svelteKitCookieStore(
  cookies: Cookies,
): CookieStore & { writes: CookieWrite[] } {
  const writes: CookieWrite[] = [];
  return {
    writes,
    // A cookie deleted earlier in this request reads back as "".
    get: (name) => cookies.get(name) || undefined,
    set: (name, value, options) => {
      const opts = { ...options, path: options?.path ?? "/" };
      cookies.set(name, value, opts);
      writes.push({ name, value, options: opts });
    },
    delete: (name, options) => {
      const opts = { ...options, path: options?.path ?? "/" };
      cookies.delete(name, opts);
      writes.push({ name, value: "", options: { ...opts, maxAge: 0 } });
    },
  };
}

/**
 * `response` with the recorded cookie writes added as `Set-Cookie` headers,
 * unless it has them already. SvelteKit adds them to the responses that went
 * through its own `resolve()`, but not to a `Response` that a hook returns
 * without it.
 */
function withCookies(
  event: RequestEvent,
  response: Response,
  writes: CookieWrite[],
): Response {
  if (writes.length === 0) return response;
  // For a client-side navigation, SvelteKit turns a returned redirect into a
  // JSON response after the hooks, without its headers, even when they
  // already carry the cookies. A thrown redirect gets the cookies from
  // SvelteKit instead.
  const location = response.headers.get("location");
  if (
    event.isDataRequest &&
    response.status >= 300 &&
    response.status <= 308 &&
    location
  ) {
    redirect(response.status as 300, location);
  }
  const cookies = event.cookies;
  const present = new Set(
    response.headers.getSetCookie().map((c) => c.split("=", 1)[0]),
  );
  // The last write of each cookie wins.
  const missing = new Map(
    writes.filter((w) => !present.has(w.name)).map((w) => [w.name, w]),
  );
  if (missing.size === 0) return response;
  // The headers of a fetched or static response can be immutable.
  const copy = new Response(response.body, response);
  for (const { name, value, options } of missing.values()) {
    copy.headers.append("set-cookie", cookies.serialize(name, value, options));
  }
  return copy;
}

/**
 * Build the SvelteKit server helpers from one config.
 *
 * ```ts
 * // src/lib/server/convexAuth.ts
 * import { setupConvexAuthSvelteKit } from "@convex-dev/auth/ssr/sveltekit";
 * import { api } from "../convex/_generated/api";
 *
 * export const {
 *   convexAuthSvelteKitHandle,
 *   convexAuthSvelteKitAccessToken,
 *   isAuthenticatedSvelteKit,
 * } = setupConvexAuthSvelteKit({
 *   convexUrl: "https://small-mouse-123.convex.cloud", // e.g. PUBLIC_CONVEX_URL
 *   refreshSession: api.auth.refreshSession,
 *   isAuthenticated: api.auth.isAuthenticated,
 * });
 * ```
 */
export function setupConvexAuthSvelteKit(config: ConvexAuthSvelteKitConfig) {
  const httpClient = new ConvexHttpClient(config.convexUrl);
  const cookieOptions: AuthCookieOptions = {
    ...config.cookieOptions,
    secure: config.cookieOptions?.secure ?? !dev,
  };
  const authRoutes = new Set(
    config.authRoutes ?? ["/auth/signin", "/auth/refresh", "/auth/signout"],
  );
  const checkAuthenticated = createServerAuthChecker({
    convexUrl: config.convexUrl,
    isAuthenticated: config.isAuthenticated,
  });

  // Memoized per request, keyed by the `Request` that the hook and the load
  // functions of one request share.
  const authChecks = new WeakMap<Request, Promise<boolean>>();

  /**
   * Build the `handle` hook: the counterpart of `convexAuthNextjsProxy`. It
   * refreshes the session when the access token is close to expiry (rotating
   * the cookies), runs your optional `handler`, and resolves the request with
   * the token set for `convex-svelte`'s `createConvexHttpClient()` and
   * `convexLoad()`.
   *
   * ```ts
   * // src/hooks.server.ts
   * import { redirect } from "@sveltejs/kit";
   * import { setupConvexAuthSvelteKit } from "@convex-dev/auth/ssr/sveltekit";
   * import { api } from "../convex/_generated/api";
   *
   * const { convexAuthSvelteKitHandle } = setupConvexAuthSvelteKit({
   *   convexUrl: "https://small-mouse-123.convex.cloud",
   *   refreshSession: api.auth.refreshSession,
   *   isAuthenticated: api.auth.isAuthenticated,
   * });
   *
   * export const handle = convexAuthSvelteKitHandle(async (event, { isAuthenticated }) => {
   *   if (event.url.pathname.startsWith("/product") && !(await isAuthenticated())) {
   *     redirect(307, "/signin");
   *   }
   * });
   * ```
   */
  function convexAuthSvelteKitHandle(
    handler?: ConvexAuthSvelteKitHandler,
  ): Handle {
    return async ({ event, resolve }) => {
      // The auth routes set their own cookies from those of the request, so
      // a refresh here would rotate the refresh token under them.
      if (authRoutes.has(event.url.pathname)) {
        return resolve(event);
      }
      const cookies = svelteKitCookieStore(event.cookies);
      const session = new ServerAuthSession({
        refreshSession: (refreshToken) =>
          httpClient.mutation(config.refreshSession, { refreshToken }),
        cookies,
        cookieOptions,
      });
      const token = await session.getToken();
      if (handler !== undefined) {
        // A thrown `redirect()` gets the cookies from SvelteKit.
        const response = await handler(event, {
          isAuthenticated: () => isAuthenticatedSvelteKit(event),
          getToken: () => session.getToken(),
        });
        if (response) return withCookies(event, response, cookies.writes);
      }
      // A later hook in a `sequence()` can return a `Response` without
      // resolving, which would drop the refreshed cookies.
      const response = await withServerConvexToken(token ?? undefined, () =>
        resolve(event),
      );
      return withCookies(event, response, cookies.writes);
    };
  }

  /**
   * The access token of the request, or `null`: the counterpart of
   * `convexAuthNextjsAccessToken`. Never triggers a refresh (the hook does
   * that) and returns `null` for an expired token. Return it from your root
   * `+layout.server.ts` for the `initialToken` of the client's
   * `setupConvexAuthSvelteKit`.
   *
   * Only the expiry is checked, not the signature. That's safe for
   * authenticating calls to Convex, which verifies the token. To decide
   * whether the request is signed in, use {@link isAuthenticatedSvelteKit}.
   */
  function convexAuthSvelteKitAccessToken(event: RequestEvent): string | null {
    const token = event.cookies.get(AUTH_JWT_COOKIE);
    return token && !isTokenExpiring(token, 0) ? token : null;
  }

  /**
   * Whether the request carries a live session: the counterpart of
   * `isAuthenticatedNextjs`. Verifies the access token against the backend
   * (once per request), so a forged cookie can't fake a session.
   */
  function isAuthenticatedSvelteKit(event: RequestEvent): Promise<boolean> {
    let check = authChecks.get(event.request);
    if (check === undefined) {
      check = checkAuthenticated(convexAuthSvelteKitAccessToken(event));
      authChecks.set(event.request, check);
    }
    return check;
  }

  return {
    convexAuthSvelteKitHandle,
    convexAuthSvelteKitAccessToken,
    isAuthenticatedSvelteKit,
  };
}
