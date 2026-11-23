"use client";

import { useConvexAuth, useQuery } from "convex/react";
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { AuthSignInApi } from "../browser/ambientSignInClient.ts";
import {
  INITIAL_AUTH_STATE,
  type AuthClient,
} from "../browser/sessionManager.ts";
import type {
  IsAuthenticatedFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";

export type { AuthSignInApi };

/**
 * Returns the {@link AuthClient} of the surrounding auth provider. Throws when
 * used outside an auth provider.
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

/**
 * The {@link AuthSignInApi} of the surrounding auth provider.
 *
 * @deprecated Use `useAuthClient().signIn`.
 */
export function useAuthSignInApi(): AuthSignInApi {
  return useAuthClient().signIn;
}

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

/**
 * The bound {@link AuthClient}. Read it with {@link useAuthClient}.
 */
export const AuthClientContext = createContext<AuthClient | undefined>(
  undefined,
);

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
 * Watches the app's `isAuthenticated` query and signs the client out when its
 * session is revoked server-side.
 *
 * The subscription (only active once the client itself authenticates) makes
 * revocation reactive: when a session is deleted, the query re-runs, the
 * result flips to `false`, and the local session is cleared without waiting
 * for the access token to expire.
 *
 * Upon `false`, it triggers a full `signOut`. In addition to clearing client
 * signed-in state, under SSR it clears the cookies holding the dead tokens.
 * On an already-revoked session the Convex `signOut` call is a no-op.
 *
 * It is meant to be rendered inside `ConvexProviderWithAuth` (it subscribes
 * via `useQuery`, and reads `useConvexAuth`) by both the SPA and the Next.js
 * providers.
 */
export function SessionWatcher({
  isAuthenticated,
}: {
  isAuthenticated: IsAuthenticatedFn;
}) {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error("SessionWatcher must be rendered under AuthProvider.");
  }
  const { isAuthenticated: isClientAuthenticated } = useConvexAuth();
  const hasLiveSession = useQuery(
    isAuthenticated,
    isClientAuthenticated ? {} : "skip",
  );
  const revoked = hasLiveSession === false;
  useEffect(() => {
    if (revoked) void authClient.signOut();
  }, [revoked, authClient]);
  return null;
}

/**
 * Binds an {@link AuthClient} to React and provides the auth, actions, and
 * token contexts. Rendered by `ConvexAuthProvider` around
 * `ConvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  initialToken,
  children,
}: {
  authClient: AuthClient;
  /**
   * An access token that an SSR host rendered into the page. The first
   * `init` call stores it.
   */
  initialToken?: string | null;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    authClient.subscribe,
    authClient.getSnapshot,
    getServerSnapshot,
  );

  // The client uses the token on its first init only, so a new value does not
  // re-run init.
  const initialTokenRef = useRef(initialToken);

  useEffect(() => {
    // In StrictMode (dev) React runs this mount → cleanup → mount on the same
    // client instance, so it is init'd, disposed, then init'd again. That's
    // fine because init()/dispose() are symmetric, and the second init()
    // re-attaches the cross-tab listener the dispose() removed. Effects never
    // run on a server, so a client shared by server requests never receives
    // a user's token here.
    void authClient.init({ initialToken: initialTokenRef.current });
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
