/**
 * Client bindings for Convex Auth on SvelteKit with server-side rendering:
 * the counterpart of `ConvexAuthNextjsProvider` of `@convex-dev/auth/ssr/nextjs`.
 *
 * The refresh token lives in an httpOnly cookie that only the SvelteKit
 * server reads. Sign-in, refresh and sign-out go through the auth routes
 * mounted from `setupConvexAuthServer` (`@convex-dev/auth/ssr`), and the
 * browser only ever holds the short-lived access token.
 *
 * The hooks (`useAuthActions`, `useAuthToken`) come from
 * `@convex-dev/auth/svelte`, as they come from `@convex-dev/auth/react` under
 * Next.js. The server side is `@convex-dev/auth/ssr/sveltekit`.
 *
 * @module
 */

import { invalidateAll, replaceState } from "$app/navigation";
import {
  ConvexHttpClient,
  type ConvexClient,
  type ConvexClientOptions,
} from "convex/browser";
import { setConvexClientContext, setupConvex } from "convex-svelte";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../../browser/ambientSignInClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import { defaultStorage, type TokenStorage } from "../../browser/storage.ts";
import type {
  AuthSessionResponse,
  IsAuthenticatedFn,
} from "../../lib/types.ts";
import { oauth } from "../../methods/oauth/client.ts";
import { bindAuthClient } from "../../svelte/client.svelte.ts";

/** The options of {@link setupConvexAuthSvelteKit}. */
export type SetupConvexAuthSvelteKitOptions = {
  /**
   * The URL of your Convex deployment, for example
   * `https://small-mouse-123.convex.cloud`.
   */
  convexUrl: string;
  /**
   * The access token the page was rendered with, from
   * `convexAuthSvelteKitAccessToken(event)` in your root `+layout.server.ts`.
   * A getter, so the `data` prop of the layout isn't captured at its initial
   * value. Read once, when the client is created.
   */
  initialToken: () => string | null;
  /**
   * The app's `isAuthenticated` query, as exported from `convex/auth.ts`.
   * Passing `api.auth` works. The client watches it, so a session revoked on
   * the server signs the browser out right away.
   */
  api: { isAuthenticated: IsAuthenticatedFn };
  /**
   * An existing `ConvexClient`. If omitted, one is created with
   * `convex-svelte`'s `setupConvex(convexUrl, clientOptions)`.
   */
  client?: ConvexClient;
  /** Options for the `ConvexClient` created when `client` is omitted. */
  clientOptions?: ConvexClientOptions;
  /** The route serving `auth.convexProxyHandler`. Defaults to `/auth/signin`. */
  signInRoute?: string;
  /** The route serving `auth.refreshHandler`. Defaults to `/auth/refresh`. */
  refreshRoute?: string;
  /** The route serving `auth.signOutHandler`. Defaults to `/auth/signout`. */
  signOutRoute?: string;
  /**
   * Where the access token is kept in the browser. Defaults to
   * `localStorage`. The refresh token never leaves the httpOnly cookie.
   */
  storage?: TokenStorage;
  /**
   * Advanced. Sign-in methods that run on their own at startup, like
   * finishing an OAuth flow. Replaces the default `[oauth()]`: include
   * `oauth()` (from `@convex-dev/auth/methods/oauth/svelte`) yourself to keep
   * it.
   */
  ambientSignIns?: AmbientSignInClient[];
  /**
   * Run the `load` functions again when the user signs in, signs out or
   * switches to another session, so the server-rendered data matches the
   * new session. Defaults to `true`.
   */
  invalidateOnAuthChange?: boolean;
};

/**
 * POST to the refresh or sign-out route and read back the access-only
 * session. Both routes reply with `{ tokens }` on success and failure alike,
 * so the body is parsed regardless of status.
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
 * Strip the OAuth callback params from the URL. SvelteKit's `replaceState`
 * keeps its router in sync, but throws before the router has started, so the
 * plain History API is the fallback.
 */
function replaceUrl(url: string) {
  try {
    replaceState(url, {});
  } catch {
    window.history.replaceState(window.history.state, "", url);
  }
}

/**
 * Set up Convex Auth in a SvelteKit app with server-side rendering. Call it
 * once, in your root `+layout.svelte`, in place of `setupConvex`.
 *
 * ```ts
 * // The <script> of src/routes/+layout.svelte
 * import { setupConvexAuthSvelteKit } from "@convex-dev/auth/ssr/sveltekit/client";
 * import { api } from "../convex/_generated/api";
 *
 * let { children, data } = $props();
 *
 * setupConvexAuthSvelteKit({
 *   convexUrl: "https://small-mouse-123.convex.cloud", // e.g. PUBLIC_CONVEX_URL
 *   initialToken: () => data.convexAuthToken,
 *   api: api.auth,
 * });
 * ```
 */
export function setupConvexAuthSvelteKit(
  options: SetupConvexAuthSvelteKitOptions,
): void {
  const {
    convexUrl,
    signInRoute = "/auth/signin",
    refreshRoute = "/auth/refresh",
    signOutRoute = "/auth/signout",
  } = options;
  let convex: ConvexClient;
  if (options.client !== undefined) {
    convex = options.client;
    setConvexClientContext(convex);
  } else {
    convex = setupConvex(convexUrl, options.clientOptions);
  }

  const initialToken = options.initialToken();

  // Sign-in goes to the auth proxy route, which forwards the call to the
  // deployment and moves the minted refresh token into an httpOnly cookie.
  // It speaks the `ConvexHttpClient` wire format, so the client is a real one
  // aimed at the app. The trailing `?path=` puts the endpoint it appends in
  // the query string, so the route is static.
  const proxy = new ConvexHttpClient(`${signInRoute}?path=`, {
    skipConvexDeploymentUrlCheck: true,
    logger: options.clientOptions?.logger,
  });
  // A sign-in usually runs signed out, but a function may want the current
  // identity (for example to link an account), so the access token is
  // attached per call. `authClient` is read lazily, because the ambient
  // sign-ins receive `signInApi` while the client is constructed.
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
      refreshSession: async () => (await postAuth(refreshRoute)).tokens,
      signOut: async () => {
        await postAuth(signOutRoute);
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: convexUrl,
    initialAccessToken: initialToken,
    ambientSignIns: {
      signIns: options.ambientSignIns ?? [oauth()],
      signInApi,
      // Calls that mint no session, like starting an OAuth flow, go to the
      // deployment, because the proxy refuses them.
      convex: { mutation: (fn, args) => convex.mutation(fn, args) },
      replaceUrl,
    },
  });

  const invalidate = options.invalidateOnAuthChange ?? true;
  bindAuthClient({
    authClient,
    convex,
    signInApi,
    isAuthenticated: options.api.isAuthenticated,
    initialToken,
    onAuthChange: invalidate ? () => void invalidateAll() : undefined,
  });
}
