/**
 * React bindings for Convex Auth.
 *
 * Wrap your app in {@link ConvexAuthProvider} (in place of `ConvexProvider`) to
 * enable authentication. The provider owns the token lifecycle — storing the
 * session, refreshing the access token, signing out — and feeds Convex's
 * `ConvexProviderWithAuth` a `useAuth` hook.
 *
 * Sign-in methods are deliberately not part of this core: each sign-in method
 * (password, OAuth, passkey, …) ships its own authentication API that returns a
 * {@link TokenBundle}. Hand that bundle to {@link useAuthActions}'s `setSession`
 * which allows the Convex client to authenticate with the backend.
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useContext, useMemo } from "react";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { TokenStorage, defaultStorage } from "../browser/storage.ts";
import { oauth } from "../methods/oauth/client.ts";
import type { ConvexAuthApi } from "../lib/types.ts";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
} from "./client.tsx";

export type { TokenStorage } from "../browser/storage.ts";
export type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";
export type { ConvexAuthActionsContextType } from "./client.tsx";

/**
 * Replace your `ConvexProvider` with this to enable authentication.
 *
 * ```tsx
 * import { ConvexAuthProvider } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return (
 *     <ConvexAuthProvider
 *       client={convex}
 *       api={{ refreshSession: api.auth.refreshSession, signOut: api.auth.signOut }}
 *     >
 *       {children}
 *     </ConvexAuthProvider>
 *   );
 * }
 * ```
 */
export function ConvexAuthProvider({
  client,
  api,
  storage,
  storageNamespace,
  ambientSignIns,
  children,
}: {
  /** Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient). */
  client: ConvexReactClient;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthApi;
  /**
   * A custom {@link TokenStorage} implementation.
   *
   * If none is supplied, the system defaults to `localStorage` in the browser
   * and in-memory where there is no `localStorage` (SSR).
   *
   * Client runtimes with no `localStorage` like React Native are strongly
   * advised to provide an implementation, because the in-memory default will
   * cause users to get logged out each time the app closes.
   *
   * Here's an example of an implementation for Expo that could be passed in
   * here:
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
   * Namespace for storage keys, which determines whether tokens are shared.
   * Non-alphanumeric characters are ignored. Defaults to the deployment URL.
   */
  storageNamespace?: string;
  /**
   * Advanced. Ambient sign-ins run initialization for sign-in methods that can
   * take action outside of a user activated sign in flow, such as reading an
   * oauth code from a url query param.
   *
   * Setting this replaces the default (`[oauth()]`) entirely rather than adding
   * to it. Pass `[]` to register nothing, or include `oauth()` (from
   * `@convex-dev/auth/methods/oauth/react`) yourself to keep it alongside
   * other sign-ins. Read once when the client is created and not expected to
   * change.
   */
  ambientSignIns?: AmbientSignInClient[];
  children: ReactNode;
}) {
  const { authClient, signInApi } = useMemo(() => {
    // Refresh and sign-out go over a *separate* HTTP client, not the websocket
    // `client`. A refresh happens while `client` is paused waiting for a token,
    // so calling it through `client` would deadlock on the very handshake the
    // refresh is meant to satisfy.
    const httpClient = new ConvexHttpClient(client.url, {
      logger: client.logger,
    });
    // Sign-in functions run against the deployment over the same websocket
    // client as the rest of the app (it isn't paused pre-auth, unlike the
    // refresh path below), so the response carries the full token bundle for
    // `setSession` to persist. The same object serves the setups of the
    // methods here and, via AuthProvider below, the hooks of the methods.
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => client.mutation(fn, args),
      action: (fn, args) => client.action(fn, args),
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
      storage: storage ?? defaultStorage(),
      storageNamespace: storageNamespace ?? client.url,
      ambientSignIns: {
        signIns: ambientSignIns ?? [oauth()],
        signInApi,
        // Mutations that mint no session use the same websocket client.
        convex: { mutation: (fn, args) => client.mutation(fn, args) },
      },
    });
    return { authClient, signInApi };
    // `client` identity is what matters. The other props are read once at
    // construction and are not expected to change.
  }, [client]);

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * Access the auth actions:
 *
 * ```ts
 * const { setSession, signOut } = useAuthActions();
 * ```
 *
 * - `setSession` adopts a {@link TokenBundle} produced by the sign-in of a
 *   method.
 * - `signOut` revokes and clears the session.
 */
export function useAuthActions() {
  const actions = useContext(ConvexAuthActionsContext);
  if (actions === undefined) {
    throw new Error(
      "useAuthActions must be used within a <ConvexAuthProvider>.",
    );
  }
  return actions;
}

/**
 * The current access token (a JWT), or null when signed out.
 *
 * Use it to authenticate requests to your Convex HTTP actions
 * (`Authorization: Bearer <token>`). Treat it as an ID token — do not send it
 * to other servers.
 */
export function useAuthToken() {
  return useContext(ConvexAuthTokenContext);
}
