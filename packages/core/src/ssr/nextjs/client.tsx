/**
 * Client bindings for Convex Auth on Next.js (App Router). This module is not
 * an entry point: the `ConvexAuthNextjsServerProvider` of
 * `@convex-dev/auth/ssr/nextjs` renders its provider, and Client Components
 * import the hooks from `@convex-dev/auth/react`.
 *
 * When running under SSR, authentication is performed for two parties:
 *
 *  1. The Convex client (for all of the reactive/transactional client-side
 *     goodness)
 *  2. The browser itself (for authenticated requests to the SSR host)
 *
 * Under SSR the refresh token lives only in a server-only httpOnly cookie, so
 * client JS can only read the access token. {@link ConvexAuthNextjsProvider}
 * configures the core {@link AuthClient} in that mode: it refreshes and signs
 * out by POSTing to the SSR host's auth routes (which read the cookie) rather
 * than talking to Convex directly.
 *
 * Sign-in likewise runs on the server, but methods need no SSR-specific hook
 * for it. {@link ConvexAuthNextjsProvider} supplies an {@link AuthSignInApi} backed
 * by a `ConvexHttpClient` aimed at the SSR host's auth proxy, so the
 * normal client hook of a method works unchanged: the proxy mints the session, stashes the
 * refresh token in the cookie, and returns an access-only
 * {@link SlimTokenBundle} for the client to authenticate to Convex with.
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";
import type { AmbientSignInClient } from "../../browser/ambientSignInClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import { TokenStorage, defaultStorage } from "../../browser/storage.ts";
import type { AuthSessionResponse } from "../../lib/types.ts";
import { oauth } from "../../methods/oauth/client.ts";
import {
  AuthProvider,
  useAuth,
  type AuthSignInApi,
} from "../../react/client.tsx";

/**
 * POST to the refresh or sign-out route and read back the access-only bundle.
 *
 * These two have their own handlers rather than going through the auth proxy,
 * because the refresh token they need is in the cookie rather than in any
 * argument the client could pass. Both reply with an
 * {@link AuthSessionResponse} on failure as on success (a dead session is a 401
 * carrying `tokens: null`), so the body is parsed regardless of status. Anything
 * without a JSON body degrades to `tokens: null`.
 */
async function postAuth(route: string): Promise<AuthSessionResponse> {
  const res = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return (await res
    .json()
    .catch(() => ({ tokens: null }))) as AuthSessionResponse;
}

/**
 * Wrap your app in this (in a Client Component, typically rendered by the
 * server-side `ConvexAuthNextjsServerProvider`) to enable authentication under
 * SSR.
 *
 * It holds the {@link ConvexReactClient} and wraps it with {@link
 * ConvexProviderWithAuth} so it is properly configured for the SSR auth
 * environment.
 */
export function ConvexAuthNextjsProvider(props: {
  /** An existing `ConvexReactClient`. If omitted, one is created from
   * `convexUrl` (or `NEXT_PUBLIC_CONVEX_URL`). */
  client?: ConvexReactClient;
  /** The Convex deployment URL. Defaults to `NEXT_PUBLIC_CONVEX_URL`. */
  convexUrl?: string;
  /** The access token from SSR host, if available, so the Convex client
   * hydrates ready to authenticate. */
  initialToken?: string | null;
  /** Route that refreshes the access token from the httpOnly cookie. */
  refreshRoute?: string;
  /** Route that revokes the session and clears cookies. */
  signOutRoute?: string;
  /** Route the auth proxy is mounted at, i.e. the single route file exporting
   * `auth.convexProxyHandler`. The sign-in calls of the methods go here. */
  signInRoute?: string;
  /** A custom {@link TokenStorage}. Defaults to `localStorage` in the browser.
   * Under SSR, it only stores the access token. */
  storage?: TokenStorage;
  /**
   * Advanced. Ambient sign-ins run initialization for sign-in methods that can
   * take action outside of a user activated sign in flow, such as reading an
   * oauth code from a url query param.
   *
   * Setting this replaces the default (`[oauth()]`) entirely rather than adding
   * to it. Pass `[]` to register nothing. Read once when the client is
   * created and not expected to change.
   *
   * Internal until the API for custom sign-in methods is stable.
   *
   * @internal
   */
  ambientSignIns?: AmbientSignInClient[];
  children: ReactNode;
}) {
  // Destructure in the body: `ambientSignIns` is internal, and a
  // destructured parameter would name it in the published declarations.
  const {
    client,
    convexUrl,
    initialToken = null,
    refreshRoute = "/auth/refresh",
    signOutRoute = "/auth/signout",
    signInRoute = "/auth/signin",
    storage,
    ambientSignIns,
    children,
  } = props;
  const { authClient, convex, signInApi } = useMemo(() => {
    const convex =
      client ??
      new ConvexReactClient(convexUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL!);
    // Sign-in goes to the auth proxy so the minted refresh token can be
    // moved into an httpOnly cookie server-side. The proxy speaks the
    // `ConvexHttpClient` wire format, so this is a real Convex client pointed at
    // the SSR host: no bespoke request shape, and args and errors keep their
    // encoding. The address is relative, hence skipping the URL check, and
    // same-origin fetch sends the auth cookies automatically. The trailing
    // `?path=` puts the endpoint the client appends into the query string, so
    // `signInRoute` can be a static route rather than a catch-all.
    const proxy = new ConvexHttpClient(`${signInRoute}?path=`, {
      skipConvexDeploymentUrlCheck: true,
      logger: convex.logger,
    });
    // Attach the current access token per call: a sign-in typically runs
    // unauthenticated, but a function may want the existing identity (e.g. to
    // link an account to the signed-in user). `authClient` is assigned below,
    // after `signInApi`, because the two reference each other: the api reads
    // the client's token, and the client hands the api to its ambient setups.
    // Those setups run inside the constructor, so the read must stay lazy.
    // TODO(erquhart) Untangle `authClient` and `signInApi` with OAuth
    // simplification.
    // eslint-disable-next-line prefer-const -- read by `withAuth` before it is assigned
    let authClient: AuthClient;
    const withAuth = () => {
      const token = authClient.getAccessToken();
      if (token !== null) proxy.setAuth(token);
      else proxy.clearAuth();
      return proxy;
    };
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => withAuth().mutation(fn, args),
      action: (fn, args) => withAuth().action(fn, args),
    };
    authClient = new AuthClient({
      mode: "ssr",
      authApi: {
        // The refresh token is read from the httpOnly cookie when it reaches the SSR host.
        refreshSession: async () => (await postAuth(refreshRoute)).tokens,
        signOut: async () => {
          await postAuth(signOutRoute);
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: convex.url,
      // The SSR host may have refreshed on our behalf, so this is the freshest
      // access token; the client adopts it on init.
      initialAccessToken: initialToken,
      ambientSignIns: {
        signIns: ambientSignIns ?? [oauth()],
        signInApi,
        // Calls that don't return a sign-in envelope, like starting an OAuth
        // flow, go to the deployment because the proxy refuses them.
        convex: { mutation: (fn, args) => convex.mutation(fn, args) },
        // Next's router keeps its own copy of the URL and writes it back on
        // its next update. Next patches replaceState to update the router,
        // but the patch skips calls that carry Next's history state. On first
        // mount, Next also installs the patch after this code runs. So we
        // strip the URL now, then call replaceState again with null state on
        // the next tick.
        replaceUrl: (url) => {
          window.history.replaceState(window.history.state, "", url);
          setTimeout(() => {
            window.history.replaceState(null, "", window.location.href);
          });
        },
      },
    });

    return { authClient, convex, signInApi };
    // `client`/`convexUrl` identity is what matters; other props are read once.
  }, [client, convexUrl]);

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}
