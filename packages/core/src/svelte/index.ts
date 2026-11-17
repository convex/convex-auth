/**
 * Svelte bindings for Convex Auth: the counterpart of `@convex-dev/auth/react`.
 *
 * {@link setupConvexAuth} replaces `ConvexAuthProvider`. The browser holds the
 * session: the access and refresh tokens live in `localStorage` (or the
 * storage you pass). For SvelteKit with server-side rendering, use
 * `setupConvexAuthSvelteKit` from `@convex-dev/auth/ssr/sveltekit/client`
 * instead, which keeps the refresh token in an httpOnly cookie.
 *
 * {@link useAuthActions} and {@link useAuthToken} work under both. For the auth
 * state, use `useAuth()` from `convex-svelte`, the counterpart of
 * `useConvexAuth()` from `convex/react`. Each sign-in method has its helpers
 * at `@convex-dev/auth/methods/<method>/svelte`.
 *
 * @module
 */

import {
  ConvexHttpClient,
  type ConvexClient,
  type ConvexClientOptions,
} from "convex/browser";
import { setConvexClientContext, setupConvex } from "convex-svelte";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { defaultStorage, type TokenStorage } from "../browser/storage.ts";
import type { ConvexAuthApi } from "../lib/types.ts";
import { oauth } from "../methods/oauth/client.ts";
import { bindAuthClient } from "./client.svelte.ts";

export {
  useAuthActions,
  useAuthToken,
  type ConvexAuthActionsContextType,
} from "./client.svelte.ts";
export type { TokenStorage } from "../browser/storage.ts";
export type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";

/** The options of {@link setupConvexAuth}. */
export type SetupConvexAuthOptions = {
  /**
   * The URL of your Convex deployment, for example
   * `https://small-mouse-123.convex.cloud`.
   */
  convexUrl: string;
  /**
   * The app's `refreshSession` and `signOut` mutations and its
   * `isAuthenticated` query, as exported from `convex/auth.ts`. Passing
   * `api.auth` works.
   */
  api: ConvexAuthApi;
  /**
   * An existing `ConvexClient`. If omitted, one is created with
   * `convex-svelte`'s `setupConvex(convexUrl, clientOptions)`. Unlike
   * `ConvexAuthProvider`, `convexUrl` is required either way, because the
   * client of `convex-svelte` doesn't expose its URL during SSR.
   */
  client?: ConvexClient;
  /** Options for the `ConvexClient` created when `client` is omitted. */
  clientOptions?: ConvexClientOptions;
  /**
   * Where tokens are persisted. Defaults to `localStorage` in the browser and
   * to memory where there is none. Use `sessionStorage` for a session per
   * tab.
   */
  storage?: TokenStorage;
  /**
   * Namespace for storage keys, which decides whether tokens are shared.
   * Non-alphanumeric characters are ignored. Defaults to `convexUrl`.
   */
  storageNamespace?: string;
  /**
   * Advanced. Sign-in methods that run on their own at startup, like
   * finishing an OAuth flow. Replaces the default `[oauth()]`: include
   * `oauth()` (from `@convex-dev/auth/methods/oauth/svelte`) yourself to keep
   * it.
   */
  ambientSignIns?: AmbientSignInClient[];
};

/**
 * Set up Convex Auth in a single-page app: the counterpart of
 * `ConvexAuthProvider`. Call it once, in your root component, in place of
 * `setupConvex`.
 *
 * ```ts
 * // The <script> of App.svelte
 * import { setupConvexAuth } from "@convex-dev/auth/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * setupConvexAuth({
 *   convexUrl: import.meta.env.VITE_CONVEX_URL,
 *   api: api.auth,
 * });
 * ```
 *
 * Components below it sign in with the helpers of each method, for example
 * `useSignInWithUsernamePassword(api.auth)` from
 * `@convex-dev/auth/methods/username-password/svelte`.
 */
export function setupConvexAuth(options: SetupConvexAuthOptions): void {
  const { convexUrl, api } = options;
  let convex: ConvexClient;
  if (options.client !== undefined) {
    convex = options.client;
    setConvexClientContext(convex);
  } else {
    convex = setupConvex(convexUrl, options.clientOptions);
  }

  // Refresh and sign-out go over a separate HTTP client. A refresh happens
  // while the websocket client is paused waiting for a token, so calling it
  // over that client would deadlock.
  const httpClient = new ConvexHttpClient(convexUrl, {
    logger: options.clientOptions?.logger,
  });
  const signInApi: AuthSignInApi = {
    mutation: (fn, args) => convex.mutation(fn, args),
    action: (fn, args) => convex.action(fn, args),
  };

  const authClient = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: (refreshToken) =>
        httpClient.mutation(api.refreshSession, { refreshToken }),
      signOut: async (refreshToken) => {
        await httpClient.mutation(api.signOut, { refreshToken });
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: options.storageNamespace ?? convexUrl,
    ambientSignIns: {
      signIns: options.ambientSignIns ?? [oauth()],
      signInApi,
      convex: { mutation: (fn, args) => convex.mutation(fn, args) },
    },
  });

  bindAuthClient({
    authClient,
    convex,
    signInApi,
    isAuthenticated: api.isAuthenticated,
  });
}
