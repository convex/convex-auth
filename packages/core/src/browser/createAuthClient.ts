/**
 * The factory for the {@link AuthClient} of a single-page app.
 *
 * @module
 */
import { ConvexHttpClient } from "convex/browser";
import type { ConvexAuthApi } from "../lib/types.ts";
import { AuthClient } from "./sessionManager.ts";
import {
  type ConvexClientApi,
  type HttpClientLogger,
  deploymentUrlOf,
  loggerOf,
} from "./signInApi.ts";
import { defaultStorage, type TokenStorage } from "./storage.ts";

/**
 * The `url` option of an auth client factory. It is optional when the Convex
 * client has a `url`, and required otherwise.
 */
export type DeploymentUrlOption<C> = C extends { readonly url: string }
  ? {
      /** The Convex deployment URL. Defaults to the Convex client's URL. */
      url?: string;
    }
  : {
      /**
       * The Convex deployment URL. It is required because this Convex client
       * has no `url`.
       */
      url: string;
    };

/** Options for {@link createAuthClient}. */
export type CreateAuthClientOptions<
  C extends ConvexClientApi = ConvexClientApi,
> = {
  /**
   * The app's Convex client, a `ConvexReactClient` or a `ConvexClient`.
   * Sign-in functions run on it.
   */
  convex: C;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthApi;
  /**
   * Where the session is stored. Defaults to `localStorage` in the browser,
   * and to memory where there is no `localStorage`.
   *
   * React Native apps should pass an implementation, because the memory
   * default signs the user out each time the app closes. An example for
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
   * `url`.
   */
  storageNamespace?: string;
  /**
   * The logger for the HTTP client that refreshes and signs out. Defaults
   * to the Convex client's logger when it has one.
   */
  logger?: HttpClientLogger;
  /** Log refresh and lifecycle steps to the console. */
  verbose?: boolean;
} & DeploymentUrlOption<C>;

/**
 * Create the auth client of a single-page app. Build it once, outside React,
 * from the app's Convex client, and pass it to `ConvexAuthProvider`.
 *
 * ```ts
 * import { createAuthClient } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
 * const auth = createAuthClient({
 *   convex,
 *   api: api.auth,
 * });
 * ```
 *
 * In plain JavaScript, pass `url`, because a `ConvexClient` has no `url`. Then
 * set the Convex client's token fetcher yourself.
 *
 * ```ts
 * import { createAuthClient } from "@convex-dev/auth/browser";
 * import { ConvexClient } from "convex/browser";
 * import { api } from "../convex/_generated/api";
 *
 * const url = import.meta.env.VITE_CONVEX_URL!;
 * const convex = new ConvexClient(url);
 * const auth = createAuthClient({ convex, url, api: api.auth });
 * convex.setAuth((args) => auth.fetchAccessToken(args));
 * await auth.init();
 * ```
 */
export function createAuthClient<C extends ConvexClientApi>(
  options: CreateAuthClientOptions<C>,
): AuthClient<C> {
  const { convex, api } = options;
  const url = options.url ?? deploymentUrlOf(convex);
  if (url === undefined) {
    throw new Error(
      "[convex-auth] createAuthClient needs a url option, because this " +
        "Convex client has no url.",
    );
  }
  // Refresh and sign-out use their own HTTP client. The app's websocket client
  // is paused while it waits for a token, so a refresh sent over it would
  // deadlock.
  const httpClient = new ConvexHttpClient(url, {
    logger: options.logger ?? loggerOf(convex),
  });
  return new AuthClient<C>({
    mode: "spa",
    convex,
    url,
    authApi: {
      refreshSession: (refreshToken) =>
        httpClient.mutation(api.refreshSession, { refreshToken }),
      signOut: async (refreshToken) => {
        await httpClient.mutation(api.signOut, { refreshToken });
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: options.storageNamespace ?? url,
    verbose: options.verbose,
  });
}
