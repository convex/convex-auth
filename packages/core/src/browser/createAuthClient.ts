/**
 * The factory for an {@link AuthClient} that keeps the session in the app's
 * own storage.
 *
 * @module
 */
import { ConvexHttpClient } from "convex/browser";
import type { ConvexReactClient } from "convex/react";
import type { ConvexAuthApi, IsAuthenticatedFn } from "../lib/types.ts";
import { oauth } from "../methods/oauth/client.ts";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "./ambientSignInClient.ts";
import { AuthClient } from "./sessionManager.ts";
import { defaultStorage, type TokenStorage } from "./storage.ts";

/** Options for {@link createAuthClient}. */
export type CreateAuthClientOptions = {
  /**
   * The app's `ConvexReactClient`. The auth client uses this to call sign-in
   * functions.
   */
  convex: ConvexReactClient;
  /**
   * References to the app's `refreshSession` and `signOut` mutations and its
   * `isAuthenticated` query. Most apps pass `api.auth`.
   */
  api: ConvexAuthApi;
  /**
   * The storage for the session. Defaults to `localStorage`, or to memory
   * where there is no `localStorage`.
   *
   * The memory default signs the user out each time the app closes, so pass
   * a persistent storage where there is no `localStorage`. For example, with
   * Expo:
   *
   * ```ts
   * import * as SecureStore from "expo-secure-store";
   *
   * const secureStorage = {
   *   getItem: SecureStore.getItemAsync,
   *   setItem: SecureStore.setItemAsync,
   *   removeItem: SecureStore.deleteItemAsync,
   * };
   * ```
   */
  storage?: TokenStorage;
  /**
   * The namespace for storage keys. Two clients with the same namespace
   * share a session. Non-alphanumeric characters are ignored. Defaults to
   * the deployment URL.
   */
  storageNamespace?: string;
  /** Log refresh and lifecycle steps to the console. */
  verbose?: boolean;
};

/**
 * An {@link AuthClient} whose `convex` and `isAuthenticatedQuery` properties
 * are always set.
 */
export type ConvexAuthClient = AuthClient & {
  readonly convex: ConvexReactClient;
  readonly isAuthenticatedQuery: IsAuthenticatedFn;
};

/**
 * Returns an auth client that keeps the session in the app's own storage.
 *
 * ```ts
 * import { createAuthClient } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
 * const auth = createAuthClient({ convex, api: api.auth });
 * ```
 */
export function createAuthClient(
  options: CreateAuthClientOptions,
): ConvexAuthClient {
  return buildSpaAuthClient(options, [oauth()]);
}

/**
 * Returns an auth client that keeps the session in the app's own storage,
 * with the given ambient sign-ins.
 *
 * @internal
 */
export function buildSpaAuthClient(
  options: CreateAuthClientOptions,
  ambientSignIns: ReadonlyArray<AmbientSignInClient>,
): ConvexAuthClient {
  const { api, convex } = options;
  const url = convex.url;
  // Refresh and sign-out use their own HTTP client. The app's websocket client
  // is paused while it waits for a token, so a refresh sent over it would
  // deadlock.
  const httpClient = new ConvexHttpClient(url, { logger: convex.logger });
  // Sign-in functions can go through the websocket client because it is not
  // paused before the user signs in.
  const signInApi: AuthSignInApi = {
    mutation: (fn, args) => convex.mutation(fn, args),
    action: (fn, args) => convex.action(fn, args),
  };
  const authClient = new AuthClient({
    mode: "spa",
    convex,
    isAuthenticatedQuery: api.isAuthenticated,
    signInApi,
    authApi: {
      refreshSession: (refreshToken) =>
        httpClient.mutation(api.refreshSession, { refreshToken }),
      signOut: async (refreshToken) => {
        await httpClient.mutation(api.signOut, { refreshToken });
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: options.storageNamespace ?? url,
    ambientSignIns: {
      signIns: ambientSignIns,
      signInApi,
      convex: { mutation: (fn, args) => convex.mutation(fn, args) },
    },
    verbose: options.verbose,
  });
  // The cast is safe because the config sets `convex` and
  // `isAuthenticatedQuery` from required options.
  return authClient as ConvexAuthClient;
}
