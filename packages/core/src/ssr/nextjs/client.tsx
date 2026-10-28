/**
 * Client bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/ssr/nextjs/client`. Client Components import the hooks
 * from `@convex-dev/auth/react`.
 *
 * When running under SSR, authentication is performed for two parties:
 *
 *  1. The Convex client (for all of the reactive/transactional client-side
 *     goodness)
 *  2. The browser itself (for authenticated requests to the SSR host)
 *
 * Under SSR the refresh token lives only in a server-only httpOnly cookie, so
 * client JS can only read the access token. The auth client from
 * {@link createNextjsAuthClient} refreshes and signs out by POSTing to the SSR
 * host's auth routes (which read the cookie) rather than talking to Convex
 * directly.
 *
 * Sign-in likewise runs on the server, but providers need no SSR-specific hook
 * for it. The auth client's sign-in API is a `ConvexHttpClient` aimed at the
 * SSR host's auth proxy, so a provider's normal client hook works unchanged:
 * the proxy mints the session, stores the refresh token in the cookie, and
 * returns an access-only {@link SlimTokenBundle} for the client to
 * authenticate to Convex with. Other calls run on the Convex client passed as
 * `convex`.
 *
 * A Server Component cannot pass the auth client to a Client Component, so the
 * app builds both clients in a Client Component file of its own, and renders
 * it inside the `ConvexAuthNextjsServerProvider` of
 * `@convex-dev/auth/ssr/nextjs`.
 *
 * ```tsx
 * "use client";
 *
 * import {
 *   ConvexAuthNextjsProvider,
 *   createNextjsAuthClient,
 * } from "@convex-dev/auth/ssr/nextjs/client";
 * import { ConvexReactClient } from "convex/react";
 * import type { ReactNode } from "react";
 *
 * const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
 * const auth = createNextjsAuthClient({ convex });
 *
 * export function ConvexClientProvider({ children }: { children: ReactNode }) {
 *   return (
 *     <ConvexAuthNextjsProvider auth={auth}>{children}</ConvexAuthNextjsProvider>
 *   );
 * }
 * ```
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { ReactNode, createContext, useContext } from "react";
import type { DeploymentUrlOption } from "../../browser/createAuthClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import {
  type ConvexClientApi,
  type HttpClientLogger,
  deploymentUrlOf,
  loggerOf,
} from "../../browser/signInApi.ts";
import { TokenStorage, defaultStorage } from "../../browser/storage.ts";
import type { AuthSessionResponse } from "../../lib/types.ts";
import { oauth } from "../../methods/oauth/client.ts";
import {
  AuthProvider,
  useAuth,
  useAuthConvexClient,
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
 * Next's router keeps its own copy of the URL and writes it back on its next
 * update. Next patches replaceState to update the router, but the patch skips
 * calls that carry Next's history state. On first mount, Next also installs
 * the patch after this code runs. So this strips the URL now, then calls
 * replaceState again with null state on the next tick.
 */
function replaceNextjsUrl(url: string): void {
  window.history.replaceState(window.history.state, "", url);
  setTimeout(() => {
    window.history.replaceState(null, "", window.location.href);
  });
}

/** Options for {@link createNextjsAuthClient}. */
export type CreateNextjsAuthClientOptions<
  C extends ConvexClientApi = ConvexClientApi,
> = {
  /**
   * The app's Convex client. `ConvexAuthNextjsProvider` renders it, and the
   * sign-in flows run their calls that mint no session on it. Sign-in
   * functions go to the auth proxy.
   */
  convex: C;
  /** Route that refreshes the access token from the httpOnly cookie. */
  refreshRoute?: string;
  /** Route that revokes the session and clears cookies. */
  signOutRoute?: string;
  /** Route the auth proxy is mounted at, i.e. the single route file exporting
   * `auth.convexProxyHandler`. Provider sign-in calls go here. */
  signInRoute?: string;
  /** A custom {@link TokenStorage}. Defaults to `localStorage` in the browser.
   * Under SSR, it only stores the access token. */
  storage?: TokenStorage;
  /** The namespace for storage keys. Defaults to `url`. */
  storageNamespace?: string;
  /**
   * The logger for the HTTP client that calls the auth proxy. Defaults to the
   * Convex client's logger when it has one.
   */
  logger?: HttpClientLogger;
  /** Log refresh and lifecycle steps to the console. */
  verbose?: boolean;
} & DeploymentUrlOption<C>;

/**
 * Create the auth client of a Next.js app. Build it once, at module scope in
 * a `"use client"` file, and pass it to {@link ConvexAuthNextjsProvider}. The
 * routes default to `/auth/refresh`, `/auth/signout`, and `/auth/signin`.
 */
export function createNextjsAuthClient<C extends ConvexClientApi>(
  options: CreateNextjsAuthClientOptions<C>,
): AuthClient<C> {
  const {
    convex,
    refreshRoute = "/auth/refresh",
    signOutRoute = "/auth/signout",
    signInRoute = "/auth/signin",
  } = options;
  const url = options.url ?? deploymentUrlOf(convex);
  if (url === undefined) {
    throw new Error(
      "[convex-auth] createNextjsAuthClient needs a url option, because " +
        "this Convex client has no url.",
    );
  }
  // Provider sign-in goes to the auth proxy so the minted refresh token can be
  // moved into an httpOnly cookie server-side. The proxy speaks the
  // `ConvexHttpClient` wire format, so this is a real Convex client pointed at
  // the SSR host: no bespoke request shape, and args and errors keep their
  // encoding. The address is relative, hence skipping the URL check, and
  // same-origin fetch sends the auth cookies automatically. The trailing
  // `?path=` puts the endpoint the client appends into the query string, so
  // `signInRoute` can be a static route rather than a catch-all.
  const proxy = new ConvexHttpClient(`${signInRoute}?path=`, {
    skipConvexDeploymentUrlCheck: true,
    logger: options.logger ?? loggerOf(convex),
  });
  // Attach the current access token per call: a sign-in typically runs
  // unauthenticated, but a function may want the existing identity (e.g. to
  // link an account to the signed-in user). It runs only after `auth` is
  // built.
  const withAuth = () => {
    const token = auth.getAccessToken();
    if (token !== null) proxy.setAuth(token);
    else proxy.clearAuth();
    return proxy;
  };
  const auth = new AuthClient<C>({
    mode: "ssr",
    convex,
    url,
    signInApi: {
      mutation: (fn, args) => withAuth().mutation(fn, args),
      action: (fn, args) => withAuth().action(fn, args),
    },
    authApi: {
      // The refresh token is read from the httpOnly cookie when it reaches the SSR host.
      refreshSession: async () => (await postAuth(refreshRoute)).tokens,
      signOut: async () => {
        await postAuth(signOutRoute);
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: options.storageNamespace ?? url,
    ambientSignIns: [oauth()],
    replaceUrl: replaceNextjsUrl,
    verbose: options.verbose,
  });
  return auth;
}

/** The access token that `ConvexAuthNextjsServerProvider` read from the cookie. */
const InitialTokenContext = createContext<string | null>(null);

/**
 * Rendered by `ConvexAuthNextjsServerProvider` with the access token from the
 * cookie, for {@link ConvexAuthNextjsProvider} to read.
 *
 * @internal
 */
export function ConvexAuthNextjsServerStateProvider({
  initialToken,
  children,
}: {
  initialToken: string | null;
  children: ReactNode;
}) {
  return (
    <InitialTokenContext.Provider value={initialToken}>
      {children}
    </InitialTokenContext.Provider>
  );
}

/**
 * Wrap your app in this, in a Client Component rendered inside the server-side
 * `ConvexAuthNextjsServerProvider`, to enable authentication under SSR. See
 * the module docs for an example.
 *
 * It renders the auth client's {@link ConvexReactClient} inside
 * {@link ConvexProviderWithAuth}. The auth client stores the access token that
 * `ConvexAuthNextjsServerProvider` read from the cookie, so the Convex client
 * hydrates ready to authenticate.
 */
export function ConvexAuthNextjsProvider({
  auth,
  children,
}: {
  /**
   * The auth client from {@link createNextjsAuthClient}, built with a
   * `ConvexReactClient`.
   */
  auth: AuthClient<ConvexReactClient>;
  children: ReactNode;
}) {
  const initialToken = useContext(InitialTokenContext);
  const convex = useAuthConvexClient(auth);
  return (
    <AuthProvider authClient={auth} initialAccessToken={initialToken}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}
