/**
 * Server bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/ssr/nextjs`.
 *
 * This is the thin, genuinely Next-specific layer. The auth *handlers*
 * (per-provider sign-in, plus refresh/sign-out) are framework-agnostic
 * `(Request) => Response` functions mounted directly as route handlers (see
 * `@convex-dev/auth/ssr`). What remains
 * Next-specific is the proxy (up-front refresh + redirects), reading the
 * access token in Server Components, and the server-side provider that hydrates
 * the client.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import { cookies as nextCookies } from "next/headers.js";
import { connection, NextRequest, NextResponse } from "next/server.js";
import { ReactNode } from "react";
import type { IsAuthenticatedFn, RefreshSessionFn } from "../../lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  AuthCookieOptions,
  CookieDeleteOptions,
  CookieOptions,
  CookieStore,
} from "../cookies.ts";
import { createServerAuthChecker } from "../isAuthenticated.ts";
import { isTokenExpiring } from "../jwt.ts";
import { ServerAuthSession } from "../session.ts";

/** Configuration for {@link setupConvexAuthNextjs}. */
export interface ConvexAuthNextjsConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. The proxy uses it for
   * its optimistic refresh. */
  refreshSession: RefreshSessionFn;
  /** The app's `isAuthenticated` query reference. Used to verify the access
   * token against the backend (which checks its signature) rather than trusting
   * the cookie by decoding it. */
  isAuthenticated: IsAuthenticatedFn;
  /** Overrides the default auth cookie attributes. Unlike the base config,
   * `secure` may be omitted here; it defaults from NODE_ENV. */
  cookieOptions?: Partial<AuthCookieOptions>;
}

/** Context handed to a proxy handler. */
export interface ConvexAuthNextjsProxyCtx {
  /** Whether the request carries a non-expired session. */
  isAuthenticated: () => Promise<boolean>;
  /** The (possibly just-refreshed) access token, or null. */
  getToken: () => Promise<string | null>;
}

/** A proxy handler: inspect the request, optionally return a response
 * (e.g. a redirect) to short-circuit. */
export type ConvexAuthNextjsProxyHandler = (
  request: NextRequest,
  ctx: ConvexAuthNextjsProxyCtx,
) => Promise<NextResponse | undefined | void> | NextResponse | undefined | void;

/**
 * Redirect helper for use inside a proxy handler.
 *
 * Part of the API returned from {@link setupConvexAuthNextjs}.
 */
function nextjsProxyRedirect(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

/**
 * A {@link CookieStore} implemented on an HTTP request/response model.
 *
 * Reads come from the cookies on the request; writes are buffered and applied
 * to the response via {@link ProxyCookieStore.applyTo}.
 */
class ProxyCookieStore implements CookieStore {
  readonly #request: NextRequest;
  readonly #overlay = new Map<string, string | null>();
  readonly #ops: Array<
    | { type: "set"; name: string; value: string; options?: CookieOptions }
    | { type: "delete"; name: string; options?: CookieDeleteOptions }
  > = [];

  constructor(request: NextRequest) {
    this.#request = request;
  }

  get(name: string): string | undefined {
    if (this.#overlay.has(name)) return this.#overlay.get(name) ?? undefined;
    return this.#request.cookies.get(name)?.value;
  }
  set(name: string, value: string, options?: CookieOptions): void {
    this.#overlay.set(name, value);
    this.#ops.push({ type: "set", name, value, options });
  }
  delete(name: string, options?: CookieDeleteOptions): void {
    this.#overlay.set(name, null);
    this.#ops.push({ type: "delete", name, options });
  }
  applyTo(response: NextResponse): void {
    for (const op of this.#ops) {
      if (op.type === "set") {
        response.cookies.set(op.name, op.value, op.options as never);
      } else {
        // Spread path/domain so the deletion matches the cookie it targets.
        response.cookies.delete({ name: op.name, ...op.options });
      }
    }
  }
}

/**
 * Build the Next.js server helpers from one config.
 *
 * ```ts
 * export const {
 *   convexAuthNextjsProxy,
 *   nextjsProxyRedirect,
 *   convexAuthNextjsAccessToken,
 *   isAuthenticatedNextjs,
 *   ConvexAuthNextjsServerProvider,
 * } = setupConvexAuthNextjs({
 *   convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
 *   refreshSession: api.auth.refreshSession,
 *   isAuthenticated: api.auth.isAuthenticated,
 * });
 * ```
 */
export function setupConvexAuthNextjs(config: ConvexAuthNextjsConfig) {
  const httpClient = new ConvexHttpClient(config.convexUrl);

  // Next sets NODE_ENV to "production" for `next build`/`next start` and
  // "development" for `next dev`, so cookies are HTTPS-only in production while
  // still working over http on localhost. An explicit `secure` still wins.
  const cookieOptions: AuthCookieOptions = {
    ...config.cookieOptions,
    secure:
      config.cookieOptions?.secure ?? process.env.NODE_ENV === "production",
  };

  const newSession = (cookies: CookieStore) =>
    new ServerAuthSession({
      refreshSession: (refreshToken) =>
        httpClient.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions,
    });

  // Verifies an access token against the backend (which checks its signature),
  // so a forged cookie can't fake authentication.
  const checkAuthenticated = createServerAuthChecker({
    convexUrl: config.convexUrl,
    isAuthenticated: config.isAuthenticated,
  });

  /** Build a Next.js proxy (`proxy.ts`) that refreshes the session up front
   * (so downstream Server Components see a fresh token) and optionally runs
   * redirect logic. */
  function convexAuthNextjsProxy(handler?: ConvexAuthNextjsProxyHandler) {
    return async (request: NextRequest): Promise<NextResponse> => {
      const cookies = new ProxyCookieStore(request);
      const session = newSession(cookies);
      await session.getToken(); // refresh if near expiry, rewriting cookies

      let response: NextResponse | undefined;
      if (handler) {
        const result = await handler(request, {
          isAuthenticated: async () =>
            checkAuthenticated(await session.getToken()),
          getToken: () => session.getToken(),
        });
        if (result) response = result;
      }
      response = response ?? NextResponse.next();
      cookies.applyTo(response);
      return response;
    };
  }

  /**
   * The current access token in a Server Component, or null. Never triggers a
   * refresh (the proxy does that); returns null for an expired token.
   *
   * The token is returned after only a local expiry check, not a signature
   * check — that is safe because its only use is to authenticate a request to
   * the Convex backend (e.g. `preloadQuery`), which verifies the signature
   * itself. To decide *authentication state* server-side, use
   * {@link isAuthenticatedNextjs} instead, which verifies against the backend.
   */
  async function convexAuthNextjsAccessToken(): Promise<string | null> {
    const token = (await nextCookies()).get(AUTH_JWT_COOKIE)?.value ?? null;
    if (token === null) return null;
    // The expiry check reads the clock. With Cache Components (and Partial
    // Prefetching), Next refuses `Date.now()` during a prerender until the
    // render has opted into request time, which reading cookies alone doesn't
    // do, so do it explicitly first.
    await connection();
    return !isTokenExpiring(token, 0) ? token : null;
  }

  /**
   * Whether the current request carries a valid, signed-in session. Verifies
   * the cookie's access token against the backend (which checks its signature),
   * so a forged cookie can't fake authentication.
   */
  async function isAuthenticatedNextjs(): Promise<boolean> {
    return checkAuthenticated(await convexAuthNextjsAccessToken());
  }

  /** Server Component that reads the cookie token and renders the client
   * provider, so the client hydrates ready to authenticate. */
  // TODO: Accept `signInRoute`, `refreshRoute`, and `signOutRoute` and pass
  // them through to `ConvexAuthNextjsProvider`, so the auth route handlers can
  // be mounted somewhere other than the default `/auth/*` paths.
  async function ConvexAuthNextjsServerProvider({
    children,
  }: {
    children: ReactNode;
  }) {
    const initialToken = await convexAuthNextjsAccessToken();
    // Lazily import the client component so other consumers of this module
    // don't have to take on those dependencies.
    const { ConvexAuthNextjsProvider } = await import("./client.tsx");
    return (
      <ConvexAuthNextjsProvider
        convexUrl={config.convexUrl}
        initialToken={initialToken}
      >
        {children}
      </ConvexAuthNextjsProvider>
    );
  }

  return {
    convexAuthNextjsProxy,
    nextjsProxyRedirect,
    convexAuthNextjsAccessToken,
    isAuthenticatedNextjs,
    ConvexAuthNextjsServerProvider,
  };
}
