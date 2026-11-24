/**
 * The factory for the {@link AuthClient} of a single-page app.
 *
 * @module
 */
import { ConvexHttpClient } from "convex/browser";
import type { ConvexReactClient } from "convex/react";
import type { ConvexAuthApi } from "../lib/types.ts";
import { oauth } from "../methods/oauth/client.ts";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "./ambientSignInClient.ts";
import { AuthClient, type SupportedConvexClient } from "./sessionManager.ts";
import { defaultStorage, type TokenStorage } from "./storage.ts";

/**
 * The `url` option of {@link createAuthClient}. The option is required with a
 * `ConvexClient` because a disabled `ConvexClient` has no readable URL.
 */
export type DeploymentUrlOption<C extends SupportedConvexClient> =
  C extends ConvexReactClient
    ? {
        /** The Convex deployment URL. Defaults to the Convex client's URL. */
        url?: string;
      }
    : {
        /** The Convex deployment URL. */
        url: string;
      };

/** Options for {@link createAuthClient}. */
export type CreateAuthClientOptions<
  C extends SupportedConvexClient = SupportedConvexClient,
> = {
  /**
   * The app's `ConvexReactClient` or `ConvexClient`. The auth client uses this
   * to call sign-in functions.
   */
  convex: C;
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
} & DeploymentUrlOption<C>;

/**
 * Returns the auth client of a single-page app.
 *
 * ```ts
 * import { createAuthClient } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
 * const auth = createAuthClient({ convex, api: api.auth });
 * ```
 *
 * With a `ConvexClient`, pass the `url` option. Then call `setAuth` and
 * `init` yourself.
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
export function createAuthClient<C extends SupportedConvexClient>(
  options: CreateAuthClientOptions<C>,
): AuthClient<C> {
  return buildSpaAuthClient(options, [oauth()]);
}

/**
 * Returns the auth client of a single-page app with the given ambient
 * sign-ins.
 *
 * @internal
 */
export function buildSpaAuthClient<C extends SupportedConvexClient>(
  options: CreateAuthClientOptions<C>,
  ambientSignIns: ReadonlyArray<AmbientSignInClient>,
): AuthClient<C> {
  const { api } = options;
  const convex: SupportedConvexClient = options.convex;
  const isReactClient = "url" in convex;
  const url = options.url ?? (isReactClient ? convex.url : undefined);
  if (url === undefined) {
    throw new Error(
      "[convex-auth] createAuthClient needs a url option with a ConvexClient.",
    );
  }
  // Refresh and sign-out use their own HTTP client. The app's websocket client
  // is paused while it waits for a token, so a refresh sent over it would
  // deadlock.
  const httpClient = new ConvexHttpClient(url, {
    logger: isReactClient ? convex.logger : undefined,
  });
  // Sign-in functions can go through the websocket client because it is not
  // paused before the user signs in.
  const signInApi: AuthSignInApi = {
    mutation: (fn, args) => convex.mutation(fn, args),
    action: (fn, args) => convex.action(fn, args),
  };
  return new AuthClient<C>({
    mode: "spa",
    convex: options.convex,
    isAuthenticated: api.isAuthenticated,
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
}
