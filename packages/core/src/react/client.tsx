"use client";

import { decodeJwt } from "jose";
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { AuthSignInApi } from "../browser/ambientSignInClient.ts";
import {
  INITIAL_AUTH_STATE,
  type AuthClient,
} from "../browser/sessionManager.ts";
import type { SlimTokenBundle, TokenBundle } from "../lib/types.ts";

export type { AuthSignInApi };

const ConvexAuthSignInApiContext = createContext<AuthSignInApi | undefined>(
  undefined,
);

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
 * Binds an {@link AuthClient} to React and provides the auth, actions, and
 * token contexts. Rendered by `ConvexAuthProvider` around
 * `ConvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  signInApi,
  children,
}: {
  authClient: AuthClient;
  /** How provider hooks execute their sign-in functions. See {@link AuthSignInApi}. */
  signInApi: AuthSignInApi;
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

  // A new callback makes Convex re-auth, so make one when the user changes.
  const subject = tokenSubject(state.token);
  const fetchAccessToken = useCallback(
    (args: { forceRefreshToken: boolean }) => authClient.fetchAccessToken(args),
    [authClient, subject],
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
          <ConvexAuthActionsContext.Provider value={actions}>
            <ConvexAuthTokenContext.Provider value={state.token}>
              {children}
            </ConvexAuthTokenContext.Provider>
          </ConvexAuthActionsContext.Provider>
        </ConvexAuthSignInApiContext.Provider>
      </ConvexAuthInternalContext.Provider>
    </AuthClientContext.Provider>
  );
}

/** The token's user id (decoded, not verified), or the token if it doesn't decode. */
function tokenSubject(token: string | null): string | null {
  if (token === null) return null;
  try {
    const { sub } = decodeJwt(token);
    return typeof sub === "string" ? sub : token;
  } catch {
    return token;
  }
}
