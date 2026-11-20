"use client";

import { useConvexAuth, useQuery } from "convex/react";
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
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

const ConvexAuthSignInApiContext = createContext<AuthSignInApi | undefined>(
  undefined,
);

/**
 * Unwrapped proxy transport for hooks that execute inside
 * `AuthClient.switchSession`. Under SSR `switchSession` already holds the
 * session mutex across its callback, whereas `signInApi` wraps each call in
 * `AuthClient.runSsrSignIn` (which takes the same non-reentrant mutex).
 */
const SwitchSignInApiContext = createContext<AuthSignInApi | undefined>(
  undefined,
);

/**
 * The {@link AuthSignInApi} for hooks that run inside
 * `AuthClient.switchSession`. Internal to `react/`.
 *
 * @internal
 */
export function useSwitchSignInApi(): AuthSignInApi {
  const signInApi = useContext(SwitchSignInApiContext);
  if (signInApi === undefined) {
    throw new Error(
      "useSwitchSignInApi must be used within a <ConvexAuthProvider> (or, under " +
        "Next.js, a <ConvexAuthNextjsProvider>).",
    );
  }
  return signInApi;
}

/**
 * The {@link AuthSignInApi} for the surrounding auth provider.
 *
 * Provider hooks call this to run their sign-in function instead of reaching
 * for `useMutation`/`useAction`, which is what keeps them working under either
 * session model. Throws when used outside an auth provider.
 */
export function useAuthSignInApi(): AuthSignInApi {
  const signInApi = useContext(ConvexAuthSignInApiContext);
  if (signInApi === undefined) {
    throw new Error(
      "useAuthSignInApi must be used within a <ConvexAuthProvider> (or, under " +
        "Next.js, a <ConvexAuthNextjsProvider>).",
    );
  }
  return signInApi;
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
 * The bound {@link AuthClient}. The sign-in methods read it through
 * `useAmbientSignInValue` in `react/methods.ts`. Apps do not use it.
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
  const { sessionId } = useSyncExternalStore(
    authClient.subscribe,
    authClient.getSnapshot,
    getServerSnapshot,
  );
  const { isAuthenticated: isClientAuthenticated } = useConvexAuth();
  // When the client switches sessions, `sessionId` updates before
  // `ConvexProviderWithAuth` clears and re-authenticates the websocket. Any
  // `isAuthenticated` query result observed before `isClientAuthenticated`
  // drops to `false` still belongs to the previous session and must not
  // trigger sign-out for the replacement session.
  const [watcherState, setWatcherState] = useState<{
    confirmedSessionId: string | null;
    pendingSessionId: string | null;
  }>(() => ({
    confirmedSessionId: isClientAuthenticated ? sessionId : null,
    pendingSessionId: null,
  }));

  let { confirmedSessionId, pendingSessionId } = watcherState;
  if (!isClientAuthenticated) {
    if (confirmedSessionId !== null || pendingSessionId !== null) {
      confirmedSessionId = null;
      pendingSessionId = null;
      setWatcherState({ confirmedSessionId: null, pendingSessionId: null });
    }
  } else if (confirmedSessionId === null) {
    if (sessionId !== null) {
      confirmedSessionId = sessionId;
      pendingSessionId = null;
      setWatcherState({
        confirmedSessionId: sessionId,
        pendingSessionId: null,
      });
    }
  } else if (sessionId !== confirmedSessionId) {
    if (pendingSessionId !== sessionId) {
      pendingSessionId = sessionId;
      setWatcherState({
        confirmedSessionId,
        pendingSessionId: sessionId,
      });
    }
  }

  const sessionReady =
    isClientAuthenticated &&
    sessionId !== null &&
    confirmedSessionId === sessionId &&
    pendingSessionId === null;
  const hasLiveSession = useQuery(isAuthenticated, sessionReady ? {} : "skip");
  const revoked = sessionReady && hasLiveSession === false;
  useEffect(() => {
    if (revoked) {
      void authClient.signOutIfSession(sessionId);
    }
  }, [revoked, sessionId, authClient]);
  return null;
}

/**
 * Binds an {@link AuthClient} to React and provides the auth, actions, and
 * token contexts. Rendered by `ConvexAuthProvider` around
 * `ConvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  signInApi,
  switchSignInApi = signInApi,
  children,
}: {
  authClient: AuthClient;
  /** How provider hooks execute their sign-in functions. See {@link AuthSignInApi}. */
  signInApi: AuthSignInApi;
  /**
   * Unwrapped sign-in transport for calls made inside
   * `AuthClient.switchSession`. Defaults to `signInApi` (SPA mode needs no
   * separate transport).
   */
  switchSignInApi?: AuthSignInApi;
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
    void authClient.init();
    return () => authClient.dispose();
  }, [authClient]);

  // A new function for each session. `ConvexProviderWithAuth` authenticates
  // again when this function changes, and only then (or when the client signs
  // out or loads). Without `sessionId` here, a client that moves straight
  // from one session to another would keep sending the old session's token
  // until its next refresh. A refresh keeps the session id, thus it does not
  // re-authenticate.
  const { sessionId } = state;
  const fetchAccessToken = useCallback(
    (args: { forceRefreshToken: boolean }) => authClient.fetchAccessToken(args),
    // `sessionId` is a dependency on purpose, although the function does
    // not read it.
    [authClient, sessionId],
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
        <ConvexAuthSignInApiContext.Provider value={signInApi}>
          <SwitchSignInApiContext.Provider value={switchSignInApi}>
            <ConvexAuthActionsContext.Provider value={actions}>
              <ConvexAuthTokenContext.Provider value={state.token}>
                {children}
              </ConvexAuthTokenContext.Provider>
            </ConvexAuthActionsContext.Provider>
          </SwitchSignInApiContext.Provider>
        </ConvexAuthSignInApiContext.Provider>
      </ConvexAuthInternalContext.Provider>
    </AuthClientContext.Provider>
  );
}
