/**
 * Binds an {@link AuthClient} to Svelte: the counterpart of `AuthProvider`
 * and `SessionWatcher` in `react/client.tsx`. `setupConvexAuth` (SPA) and the
 * `setupConvexAuthSvelteKit` of `ssr/sveltekit/client.ts` (SSR) share it. They
 * differ only in how they build the client: who holds the refresh token, and
 * where the sign-in functions run.
 *
 * The runes of this module compile in the app: the package ships it as
 * `client.svelte.js`, which the Svelte compiler of the app picks up.
 *
 * @module
 */

import { getContext, setContext, untrack } from "svelte";
import { setupAuth, useAuth as useConvexAuth, useQuery } from "convex-svelte";
import type { ConvexClient } from "convex/browser";
import type {
  AuthSignInApi,
  ConvexMutationApi,
} from "../browser/ambientSignInClient.ts";
import type { AuthClient } from "../browser/sessionManager.ts";
import type {
  IsAuthenticatedFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
import { createAuthChangeDetector, sessionOf } from "./authChange.ts";
import { fromReadableStore } from "./store.ts";

const CONTEXT_KEY = Symbol("@convex-dev/auth/svelte");

/**
 * What the hooks and the method helpers read from the context, set by the
 * setup functions.
 *
 * @internal
 */
export type ConvexAuthContext = {
  authClient: AuthClient;
  /** Runs the sign-in functions of the methods. */
  signInApi: AuthSignInApi;
  /** Runs the public mutations of the methods that mint no session. */
  convex: ConvexMutationApi;
};

/**
 * Set the context that the hooks and the method helpers read. The setup
 * functions call it through {@link bindAuthClient}.
 *
 * @internal Exported for the tests of the method helpers.
 */
export function setConvexAuthContext(context: ConvexAuthContext): void {
  setContext(CONTEXT_KEY, context);
}

/**
 * Read the context set by the setup functions. Call it during component
 * initialization.
 *
 * @internal
 */
export function getConvexAuthContext(caller: string): ConvexAuthContext {
  const context = getContext<ConvexAuthContext | undefined>(CONTEXT_KEY);
  if (context === undefined) {
    throw new Error(
      `${caller} must be called in a component that calls setupConvexAuth() ` +
        "or setupConvexAuthSvelteKit(), or in one below it.",
    );
  }
  return context;
}

/**
 * Hook an {@link AuthClient} into Svelte and the Convex client, and set the
 * context of the hooks and the method helpers. Call it during component
 * initialization.
 *
 * @internal
 */
export function bindAuthClient({
  authClient,
  convex,
  signInApi,
  isAuthenticated,
  initialToken,
  onAuthChange,
}: {
  authClient: AuthClient;
  convex: ConvexClient;
  signInApi: AuthSignInApi;
  /** The app's `isAuthenticated` query, watched to sign out revoked sessions. */
  isAuthenticated: IsAuthenticatedFn;
  /**
   * The access token the server rendered with, `null` when it rendered
   * signed out. SSR only: leave it out without SSR.
   */
  initialToken?: string | null;
  /**
   * Called when the client signs in, signs out or switches to another
   * session after it has loaded. With SSR, also when it finishes loading in
   * another session than the server rendered, for example after redeeming an
   * OAuth code.
   */
  onAuthChange?: (isAuthenticated: boolean) => void;
}): void {
  let snapshot = $state.raw(authClient.getSnapshot());
  // Every token refresh replaces the snapshot. The Convex client only needs
  // to hear about sign-in, sign-out and a switch to another session:
  // re-running the effect of `setupAuth` on a new token calls `setAuth`
  // again, which fetches yet another token, and so on. A refresh keeps the
  // session id (the `sub` of the token), so none of these change on it.
  const sessionLoading = $derived(snapshot.isLoading);
  const signedIn = $derived(snapshot.isAuthenticated);
  const sessionId = $derived(
    snapshot.isAuthenticated ? sessionOf(snapshot.token) : null,
  );

  // `init()` loads the session from storage (and finishes an OAuth flow that
  // redirected back). The Convex client may ask for a token before the
  // effect below has run, so the first token fetch waits for it too.
  let initPromise: Promise<void> | undefined;
  const init = () => (initPromise ??= authClient.init());

  $effect(() =>
    // Run once. `init()` can notify the subscriber synchronously (an OAuth
    // code puts the client in a pending sign-in), and tracking the reads in
    // there would run this effect again, which disposes the client.
    untrack(() => {
      const changed = createAuthChangeDetector(initialToken);
      const unsubscribe = authClient.subscribe(() => {
        const next = authClient.getSnapshot();
        snapshot = next;
        if (changed(next)) onAuthChange?.(next.isAuthenticated);
      });
      snapshot = authClient.getSnapshot();
      void init();
      return () => {
        unsubscribe();
        authClient.dispose();
      };
    }),
  );

  // A new function per session, so `setupAuth` calls `setAuth` again when
  // the client switches sessions (for example, another tab signed in as
  // someone else). Otherwise the Convex client keeps the token of the old
  // session until it expires.
  const fetchAccessToken = $derived.by(() => {
    void sessionId;
    return async (args: { forceRefreshToken: boolean }) => {
      await init();
      return await authClient.fetchAccessToken(args);
    };
  });

  // The counterpart of `ConvexProviderWithAuth`. When the server rendered
  // signed in, seeding convex-svelte with that keeps the hydrated page from
  // flashing signed out while the client loads the session.
  setupAuth(
    () => ({
      isLoading: sessionLoading,
      isAuthenticated: signedIn,
      fetchAccessToken,
    }),
    initialToken != null
      ? { initialState: { isAuthenticated: true } }
      : undefined,
  );
  const convexAuth = useConvexAuth();

  // The counterpart of `SessionWatcher`: watch the app's `isAuthenticated`
  // query while the backend accepts the token. When the session is revoked
  // server-side, the query flips to `false` and the client signs out right
  // away instead of at the next failed refresh.
  const session = useQuery(isAuthenticated, () =>
    convexAuth.isAuthenticated ? {} : "skip",
  );
  $effect(() => {
    if (session.data === false) {
      void authClient.signOut();
    }
  });

  setConvexAuthContext({
    authClient,
    signInApi,
    convex: { mutation: (fn, args) => convex.mutation(fn, args) },
  });
}

/** The value returned by {@link useAuthActions}. */
export type ConvexAuthActionsContextType = {
  /**
   * Adopt a session. The method helpers call it for you; use it for a
   * sign-in function that you call yourself. A SPA client receives a full
   * {@link TokenBundle}, a SvelteKit client the {@link SlimTokenBundle}
   * without the refresh token.
   */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
  /** Sign out: revoke the session on the server and clear it locally. */
  signOut: () => Promise<void>;
};

/**
 * Access the auth actions. Call it during component initialization.
 *
 * ```ts
 * import { useAuthActions } from "@convex-dev/auth/svelte";
 *
 * const { setSession, signOut } = useAuthActions();
 * ```
 *
 * For the auth state, use `useAuth()` from `convex-svelte`, the counterpart
 * of `useConvexAuth()` from `convex/react`.
 */
export function useAuthActions(): ConvexAuthActionsContextType {
  const { authClient } = getConvexAuthContext("useAuthActions()");
  return { setSession: authClient.setSession, signOut: authClient.signOut };
}

/**
 * The current access token (a JWT), or `null` when signed out. Call it during
 * component initialization, and read `current`, which stays reactive.
 *
 * Use it to authenticate requests to your Convex HTTP actions
 * (`Authorization: Bearer <token>`). Treat it as an ID token, and don't send
 * it to other servers.
 *
 * ```ts
 * import { useAuthToken } from "@convex-dev/auth/svelte";
 *
 * const token = useAuthToken();
 * const headers = { Authorization: `Bearer ${token.current}` };
 * ```
 */
export function useAuthToken(): { readonly current: string | null } {
  const { authClient } = getConvexAuthContext("useAuthToken()");
  const state = fromReadableStore({
    get: authClient.getSnapshot,
    subscribe: authClient.subscribe,
  });
  return {
    get current() {
      return state.current.token;
    },
  };
}
