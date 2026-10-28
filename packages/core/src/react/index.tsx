/**
 * React bindings for Convex Auth.
 *
 * Build the auth client once with {@link createAuthClient}, outside React,
 * from your `ConvexReactClient`. Then wrap your app in
 * {@link ConvexAuthProvider} in place of `ConvexProvider`. The auth client
 * stores the session, refreshes the access token, and signs out. The provider
 * passes its state to Convex's `ConvexProviderWithAuth`.
 *
 * ```tsx
 * import { ConvexAuthProvider, createAuthClient } from "@convex-dev/auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);
 * const auth = createAuthClient({
 *   convex,
 *   api: api.auth,
 * });
 *
 * function Root({ children }: { children: React.ReactNode }) {
 *   return <ConvexAuthProvider auth={auth}>{children}</ConvexAuthProvider>;
 * }
 * ```
 *
 * Authentication methods are deliberately not part of this core: each auth provider
 * (password, OAuth, passkey, …) ships its own authentication API that returns a
 * {@link TokenBundle}. Hand that bundle to {@link useAuthActions}'s `setSession`
 * which allows the Convex client to authenticate with the backend.
 *
 * @module
 */
"use client";

import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { ReactNode, useContext } from "react";
import type { AuthClient } from "../browser/sessionManager.ts";
import {
  AuthProvider,
  ConvexAuthActionsContext,
  ConvexAuthTokenContext,
  useAuth,
  useAuthConvexClient,
} from "./client.tsx";

export {
  createAuthClient,
  type CreateAuthClientOptions,
} from "../browser/createAuthClient.ts";
export type { AuthClient, AuthState } from "../browser/sessionManager.ts";
export type { TokenStorage } from "../browser/storage.ts";
export type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";
export type { ConvexAuthActionsContextType } from "./client.tsx";
export { useAuthClient, type AuthSignInApi } from "./client.tsx";

/**
 * Replace your `ConvexProvider` with this to enable authentication. See the
 * module docs for an example.
 */
export function ConvexAuthProvider({
  auth,
  children,
}: {
  /**
   * The auth client from {@link createAuthClient}, built with a
   * [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient).
   */
  auth: AuthClient<ConvexReactClient>;
  children: ReactNode;
}) {
  const convex = useAuthConvexClient(auth);
  return (
    <AuthProvider authClient={auth}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
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
 * - `setSession` adopts a {@link TokenBundle} produced by a provider's
 *   sign-in.
 * - `signOut` revokes and clears the session.
 *
 * Provider code reads the whole client with {@link useAuthClient}.
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
