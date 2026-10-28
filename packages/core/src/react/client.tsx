"use client";

import type { ConvexReactClient } from "convex/react";
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  INITIAL_AUTH_STATE,
  type AuthClient,
} from "../browser/sessionManager.ts";
import type { AuthSignInApi, ConvexClientApi } from "../browser/signInApi.ts";
import type { SlimTokenBundle, TokenBundle } from "../lib/types.ts";

export type { AuthSignInApi };

// React calls this during SSR and initial hydration — before `init()` has read
// storage — so it always reports the loading state. It lives here rather than
// on the core client because server rendering is a React-specific concern.
const getServerSnapshot = () => INITIAL_AUTH_STATE;

/** The value exposed by {@link useAuthActions}. */
export type ConvexAuthActionsContextType = {
  /**
   * Initialize or refresh a session.
   *
   * A SPA client will receive a full {@link TokenBundle} so it can access the
   * refresh token for direct session refreshing. An SSR client will receive a
   * {@link SlimTokenBundle} which doesn't include the refresh token (that
   * value is in an httpOnly cookie, not reachable by client JS code).
   */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
  /** Sign out: revoke the session on the server and clear it locally. */
  signOut: () => Promise<void>;
};

export const ConvexAuthActionsContext = createContext<
  ConvexAuthActionsContextType | undefined
>(undefined);

/** The {@link AuthClient} of the surrounding provider. */
export const AuthClientContext = createContext<AuthClient | undefined>(
  undefined,
);

/**
 * The {@link AuthClient} of the surrounding provider. Provider hooks call this
 * to run sign-in functions with `signIn`, run other functions on `convex`,
 * and store sessions with `setSession`. Throws outside a provider.
 */
export function useAuthClient(): AuthClient {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error(
      "useAuthClient must be used within a <ConvexAuthProvider> (or, under " +
        "Next.js, a <ConvexAuthNextjsProvider>).",
    );
  }
  return authClient;
}

/** Returns `auth.convex` and re-renders when `setConvex` replaces it. */
export function useAuthConvexClient<C extends ConvexClientApi>(
  auth: AuthClient<C>,
): C {
  return useSyncExternalStore(
    auth.subscribe,
    () => auth.convex,
    () => auth.convex,
  );
}

/**
 * Let the Convex client send calls once the session loads, when
 * `ConvexProviderWithAuth` does not set its auth. A `ConvexReactClient` built
 * with `expectAuth` pauses its websocket until `setAuth` runs, and
 * `ConvexProviderWithAuth` calls `setAuth` only for a signed-in user whose
 * session is not loading. Without this, a signed-out user's sign-in calls and
 * the redemption of an OAuth callback code are never sent.
 *
 * With no access token the fetcher returns null and makes no request, so the
 * Convex client resumes its websocket unauthenticated. With one, which happens
 * while a sign-in is pending, it is the auth client's fetcher, so the Convex
 * client can refresh an expired token. `ConvexProviderWithAuth` sets its own
 * auth once the user is signed in and the session is not loading.
 */
export function useResumeConvexAfterSessionLoad(
  auth: AuthClient,
  convex: ConvexReactClient,
): void {
  useEffect(() => {
    let current = true;
    // The provider's own init() call runs first, because child effects run
    // before parent effects. This call resolves when that one has loaded.
    void auth.init().then(() => {
      const { isLoading, isAuthenticated } = auth.getSnapshot();
      if (current && (isLoading || !isAuthenticated)) {
        convex.setAuth(
          async (args) =>
            auth.getAccessToken() === null
              ? null
              : await auth.fetchAccessToken(args),
          () => {},
        );
      }
    });
    return () => {
      current = false;
    };
  }, [auth, convex]);
}

/** The current access token (a JWT), or null when signed out. */
export const ConvexAuthTokenContext = createContext<string | null>(null);

/**
 * The auth state consumed by Convex's `ConvexProviderWithAuth`. Provided by
 * {@link AuthProvider} and read by the module-level {@link useAuth}.
 */
const ConvexAuthInternalContext = createContext<
  | {
      isLoading: boolean;
      isAuthenticated: boolean;
      fetchAccessToken: (args: {
        forceRefreshToken: boolean;
      }) => Promise<string | null>;
    }
  | undefined
>(undefined);

/**
 * The `useAuth` hook passed to `ConvexProviderWithAuth`. It is a stable
 * module-level function (Convex re-runs the auth handshake if this identity
 * changes) that just reads the context {@link AuthProvider} populates.
 */
export function useAuth() {
  const auth = useContext(ConvexAuthInternalContext);
  if (auth === undefined) {
    throw new Error("useAuth must be used within a <ConvexAuthProvider>.");
  }
  return auth;
}

/**
 * Binds an {@link AuthClient} to React and provides the auth, actions, and
 * token contexts. Rendered by `ConvexAuthProvider` around
 * `ConvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  initialAccessToken,
  children,
}: {
  authClient: AuthClient;
  /** An access token from an SSR host, passed to the first `init()` call. */
  initialAccessToken?: string | null;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    authClient.subscribe,
    authClient.getSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    // In StrictMode (dev) React runs this mount → cleanup → mount on the same
    // client instance, so it is init'd, disposed, then init'd again. That's
    // fine because init()/dispose() are symmetric, and the second init()
    // re-attaches the cross-tab listener the dispose() removed.
    // init() reads initialAccessToken only on its first call, so it is not a
    // dependency.
    void authClient.init({ initialAccessToken });
    return () => authClient.dispose();
  }, [authClient]);

  const fetchAccessToken = useCallback(
    (args: { forceRefreshToken: boolean }) => authClient.fetchAccessToken(args),
    [authClient],
  );

  const authState = useMemo(
    () => ({
      isLoading: state.isLoading,
      isAuthenticated: state.isAuthenticated,
      fetchAccessToken,
    }),
    [state.isLoading, state.isAuthenticated, fetchAccessToken],
  );

  const actions = useMemo<ConvexAuthActionsContextType>(
    () => ({
      setSession: authClient.setSession,
      signOut: authClient.signOut,
    }),
    [authClient],
  );

  return (
    <AuthClientContext.Provider value={authClient}>
      <ConvexAuthInternalContext.Provider value={authState}>
        <ConvexAuthActionsContext.Provider value={actions}>
          <ConvexAuthTokenContext.Provider value={state.token}>
            {children}
          </ConvexAuthTokenContext.Provider>
        </ConvexAuthActionsContext.Provider>
      </ConvexAuthInternalContext.Provider>
    </AuthClientContext.Provider>
  );
}
