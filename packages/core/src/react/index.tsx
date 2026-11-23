/**
 * React bindings for Convex Auth.
 *
 * 1. Create the auth client outside React with {@link createAuthClient}.
 * 2. Wrap your app in {@link ConvexAuthProvider} in place of
 *    `ConvexProvider`.
 *
 * The auth client stores the session, refreshes the access token, and signs
 * out. The provider passes the auth state to Convex's
 * `ConvexProviderWithAuth`.
 *
 * Sign-in methods are deliberately not part of this core: each sign-in method
 * (password, OAuth, passkey, …) ships its own authentication API that returns a
 * {@link TokenBundle}. Hand that bundle to {@link useAuthActions}'s `setSession`
 * which allows the Convex client to authenticate with the backend.
 *
 * @module
 */
"use client";

import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { ReactNode, useContext, useMemo } from "react";
import type { AmbientSignInClient } from "../browser/ambientSignInClient.ts";
import { buildSpaAuthClient } from "../browser/createAuthClient.ts";
import type { AuthClient } from "../browser/sessionManager.ts";
import type { TokenStorage } from "../browser/storage.ts";
import { oauth } from "../methods/oauth/client.ts";
import type { ConvexAuthApi } from "../lib/types.ts";
import {
  AuthProvider,
  SessionWatcher,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
} from "./client.tsx";

export {
  createAuthClient,
  type CreateAuthClientOptions,
} from "../browser/createAuthClient.ts";
export type { AuthSignInApi } from "../browser/ambientSignInClient.ts";
export type { AuthClient, AuthState } from "../browser/sessionManager.ts";
export type { TokenStorage } from "../browser/storage.ts";
export type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";
export type { ConvexAuthActionsContextType } from "./client.tsx";
export { useAuthClient } from "./client.tsx";

/** The props of {@link ConvexAuthProvider} with an auth client. */
type AuthClientProps = {
  /**
   * The auth client from {@link createAuthClient}, created with a
   * [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient).
   */
  auth: AuthClient<ConvexReactClient>;
  /**
   * An access token that the server rendered into the page. The auth client
   * stores it when it starts in the browser.
   */
  initialToken?: string | null;
  client?: never;
  api?: never;
  storage?: never;
  storageNamespace?: never;
  ambientSignIns?: never;
};

/**
 * The props of {@link ConvexAuthProvider} that build the auth client inside
 * the provider.
 */
type ConvexClientProps = {
  auth?: never;
  initialToken?: never;
  /**
   * Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient).
   *
   * @deprecated Create the auth client with {@link createAuthClient} and pass
   * it as `auth`.
   */
  client: ConvexReactClient;
  /**
   * The app's `refreshSession` and `signOut` mutation references, and its
   * `isAuthenticated` query reference. The provider subscribes to
   * `isAuthenticated`, so a session revoked server-side signs the client out
   * reactively.
   *
   * @deprecated Pass it to {@link createAuthClient}.
   */
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
   * @deprecated Pass it to {@link createAuthClient}.
   */
  storage?: TokenStorage;
  /**
   * Namespace for storage keys, which determines whether tokens are shared.
   * Non-alphanumeric characters are ignored. Defaults to the deployment URL.
   *
   * @deprecated Pass it to {@link createAuthClient}.
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
};

/** The props of {@link ConvexAuthProvider}. */
export type ConvexAuthProviderProps = (AuthClientProps | ConvexClientProps) & {
  children: ReactNode;
};

/**
 * Replace your `ConvexProvider` with this to enable authentication.
 *
 * Create the auth client once, outside React, and pass it as `auth`:
 *
 * ```tsx
 * import { ConvexAuthProvider, createAuthClient } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);
 * const auth = createAuthClient({ convex, api: api.auth });
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return <ConvexAuthProvider auth={auth}>{children}</ConvexAuthProvider>;
 * }
 * ```
 *
 * The `client` and `api` props still work in place of `auth`, but they are
 * deprecated.
 */
export function ConvexAuthProvider(props: ConvexAuthProviderProps) {
  const { auth, client, children } = props;
  if (auth !== undefined && client !== undefined) {
    throw new Error(
      "[convex-auth] Pass ConvexAuthProvider either auth or client and api, " +
        "not both.",
    );
  }
  const authClient = useMemo(() => {
    if (auth !== undefined) return auth;
    if (client === undefined) {
      throw new Error(
        "[convex-auth] ConvexAuthProvider needs an auth client. Create one " +
          "with createAuthClient and pass it as auth.",
      );
    }
    return buildSpaAuthClient(
      {
        convex: client,
        api: props.api!,
        storage: props.storage,
        storageNamespace: props.storageNamespace,
      },
      props.ambientSignIns ?? [oauth()],
    );
    // The provider builds the auth client once per `client`, so changes to the
    // other props are ignored.
  }, [auth, client]);

  const convex = authClient.convex;
  const isAuthenticated = authClient.isAuthenticated;
  if (convex === undefined || isAuthenticated === undefined) {
    throw new Error(
      "[convex-auth] ConvexAuthProvider needs an auth client from " +
        "createAuthClient.",
    );
  }

  return (
    <AuthProvider authClient={authClient} initialToken={props.initialToken}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        <SessionWatcher isAuthenticated={isAuthenticated} />
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
