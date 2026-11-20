import type {
  ClientView,
  RefreshResult,
  SignInEnvelope,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
import { KeyedStore, type SignInValuesReader } from "./keyedStore.ts";
import { isMutexHeld, runWithMutex } from "./mutex.ts";
import type {
  AmbientSignInClient,
  AuthSignInApi,
  ConvexMutationApi,
} from "./ambientSignInClient.ts";
import { retryOnNetworkError } from "./retry.ts";
import { sessionIdOfAccessToken } from "./sessionId.ts";
import {
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  TokenStorage,
} from "./storage.ts";

/**
 * The refresh and sign-out API for a **SPA** client, where JS holds the
 * refresh token directly.
 *
 * Refreshing resolves to a {@link RefreshResult}: `rotated` carries the next
 * refresh token to persist, and `noSession` means the session is gone.
 */
export interface SpaAuthApi {
  refreshSession: (refreshToken: string) => Promise<RefreshResult>;
  signOut: (refreshToken: string) => Promise<void>;
}

/**
 * The refresh and sign-out API for an **SSR** client, where the refresh token
 * lives in an httpOnly cookie that JS can't read.
 *
 * Refreshing goes through an HTTP request to the SSR host, which carries the
 * refresh token in the cookie and replies with a {@link SlimTokenBundle}
 * containing a new access token, or `null` when the session is gone.
 */
export interface SsrAuthApi {
  refreshSession: () => Promise<SlimTokenBundle | null>;
  signOut: () => Promise<void>;
}

/** Config common to both session models. */
interface AuthClientConfigBase {
  /** Where tokens are persisted. */
  storage: TokenStorage;
  /** Namespace for storage keys; typically the deployment URL. */
  storageNamespace: string;
  /**
   * An access token to store on {@link AuthClient.init}, typically provided by
   * an SSR host.
   */
  initialAccessToken?: string | null;
  /**
   * Ambient sign-ins to set up while the client is constructed, along with
   * the clients handed to each setup. See {@link AmbientSignInClient}.
   */
  ambientSignIns?: {
    signIns: ReadonlyArray<AmbientSignInClient>;
    signInApi: AuthSignInApi;
    convex: ConvexMutationApi;
    /**
     * Replaces the page URL without navigating. Defaults to
     * `history.replaceState` with the current history state.
     */
    replaceUrl?: (url: string) => void;
  };
  /** Log refresh/lifecycle steps to the console. */
  verbose?: boolean;
}

/**
 * Configuration for the {@link AuthClient}, discriminated by session `mode`.
 *
 * The mode determines who holds the refresh token, and therefore the shape of
 * the auth API the client drives:
 *  - `"spa"`: JS holds the refresh token; the client passes it to a
 *    {@link SpaAuthApi}.
 *  - `"ssr"`: the refresh token is in an httpOnly cookie; a {@link SsrAuthApi}
 *    is called without one and reads the cookie server-side.
 */
export type AuthClientConfig =
  | (AuthClientConfigBase & { mode: "spa"; authApi: SpaAuthApi })
  | (AuthClientConfigBase & { mode: "ssr"; authApi: SsrAuthApi });

/** Auth state that can be subscribed to via {@link AuthClient.subscribe} */
export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
  /**
   * The id of the session that `token` belongs to, or `null` when signed out.
   * A refresh keeps it. It changes when the client moves to another session,
   * which is when the Convex client must authenticate again.
   */
  sessionId: string | null;
}

type Listener = () => void;

/** The state a fresh client reports until {@link AuthClient.init} has loaded
 * the persisted session. Exported so framework bindings can use it as their
 * pre-hydration snapshot. */
export const INITIAL_AUTH_STATE: AuthState = Object.freeze({
  isLoading: true,
  isAuthenticated: false,
  token: null,
  sessionId: null,
});

/**
 * Whether a session carries the refresh token, i.e. is a full
 * {@link TokenBundle} rather than an access-only {@link SlimTokenBundle}.
 *
 * A type predicate rather than an inline check so callers can both branch on it
 * and narrow with it: TypeScript won't narrow a union through a plain boolean
 * held in a variable, and narrowing here is what keeps a cast out of the one
 * path that decides whether a refresh token gets persisted.
 */
function hasRefreshToken(
  session: TokenBundle | SlimTokenBundle,
): session is TokenBundle {
  return "refreshToken" in session;
}

/**
 * A refresh outcome in the terms this client persists it, normalized across the
 * two session models:
 *
 *  - `rotated`: a session to store whole. A full {@link TokenBundle} under SPA or
 *    an access-only {@link SlimTokenBundle} under SSR where the host moved the
 *    refresh token into the cookie.
 *  - `noSession`: the session is gone; clear it.
 */
type RefreshOutcome =
  | { kind: "rotated"; session: TokenBundle | SlimTokenBundle }
  | { kind: "noSession" };

/**
 * Returns the global `window` object when it supports DOM event listeners,
 * otherwise `null`.
 *
 * It will be `null` on platforms like React Native.
 */
function domEventTarget(): Pick<
  Window,
  "addEventListener" | "removeEventListener"
> | null {
  if (typeof window === "undefined") return null;
  if (
    typeof window.addEventListener !== "function" ||
    typeof window.removeEventListener !== "function"
  ) {
    return null;
  }
  return window;
}

/**
 * Replaces the page URL and keeps the current history state, because routers
 * like React Router store their own state there.
 */
function replaceUrlKeepingState(url: string): void {
  window.history.replaceState(window.history.state, "", url);
}

/**
 * What {@link AuthClient.switchSession} should do with the result of its call:
 *
 *  - a {@link TokenBundle} or {@link SlimTokenBundle}: adopt the new session
 *  - `"signOut"`: the backend ended the session; clear local tokens (and under
 *    SSR, clear cookies)
 *  - `null`: leave the current session untouched
 */
export type SessionSwitchAction =
  TokenBundle | SlimTokenBundle | "signOut" | null;

const MAX_REMEMBERED_SIGN_IN_TOKENS = 32;

/**
 * Framework-agnostic owner of the auth session on the client.
 *
 * It persists the {@link TokenBundle} from a sign-in, hands out the access
 * token via {@link AuthClient.fetchAccessToken} (refreshing under a cross-tab
 * lock when forced), keeps in sync across tabs, and exposes a
 * subscribe/snapshot API so any UI framework can render its state. It
 * establishes sessions from the authentication results of the sign-in methods.
 * Methods authenticate and sign-in users and call {@link AuthClient.setSession} with
 * a token bundle.
 */
export class AuthClient {
  /** Refresh the session, resolving to one of the {@link RefreshOutcome} arms. */
  readonly #refresh: () => Promise<RefreshOutcome>;
  /** Revoke the session on the server (using `refreshTokenOverride` in SPA mode when provided). */
  readonly #signOutInternal: (
    refreshTokenOverride?: string | null,
  ) => Promise<void>;
  readonly #storage: NamespacedStorage;
  readonly #verbose: boolean;
  readonly #lockKey: string;
  /** The key of the mutex that {@link AuthClient.switchSession} holds. */
  readonly #switchLockKey: string;
  readonly #initialAccessToken: string | null;
  /**
   * Which side owns the refresh token: this client (SPA) or an httpOnly cookie
   * (SSR). Enforced in {@link AuthClient.#storeFullTokenResult}.
   */
  readonly #mode: "spa" | "ssr";

  #accessToken: string | null = null;
  /**
   * If the client code is running in SSR mode, this value will always be
   * `null`.
   */
  #refreshToken: string | null = null;
  #isLoading = true;
  #pendingSignIns = 0;
  /** How many {@link AuthClient.switchSession} calls are under way. */
  #pendingSwitches = 0;
  /**
   * Whether a refresh reported that the session is gone while a session
   * switch was under way. See {@link AuthClient.switchSession}.
   */
  #heldNoSession = false;
  /**
   * Access tokens already adopted atomically inside
   * {@link AuthClient.runSsrSignIn}. The follow-up {@link AuthClient.setSession}
   * call for the same token becomes a no-op so it cannot overwrite a newer
   * session that landed in between.
   */
  readonly #adoptedBySignIn = new Set<string>();
  #initialized = false;

  #snapshot: AuthState = INITIAL_AUTH_STATE;
  readonly #listeners = new Set<Listener>();
  #storageListener: ((event: StorageEvent) => void) | null = null;

  constructor(config: AuthClientConfig) {
    this.#storage = new NamespacedStorage(
      config.storage,
      config.storageNamespace,
    );
    this.#verbose = config.verbose ?? false;
    this.#lockKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
    this.#switchLockKey = this.#storage.key("__convexAuthSessionSwitch");
    this.#initialAccessToken = config.initialAccessToken ?? null;
    this.#mode = config.mode;

    // Bind the mode-specific refresh/sign-out behavior.
    if (config.mode === "spa") {
      const { authApi } = config;
      this.#refresh = async () => {
        const refreshToken = await this.#currentRefreshToken();
        // No token means there's no session to refresh — don't call the API.
        if (refreshToken === null) return { kind: "noSession" };
        const result = await authApi.refreshSession(refreshToken);
        switch (result.kind) {
          case "rotated":
            return { kind: "rotated", session: result.tokens };
          case "noSession":
            return { kind: "noSession" };
        }
      };
      this.#signOutInternal = async (refreshTokenOverride) => {
        const refreshToken =
          refreshTokenOverride !== undefined
            ? refreshTokenOverride
            : await this.#currentRefreshToken();
        if (refreshToken !== null) await authApi.signOut(refreshToken);
      };
    } else {
      const { authApi } = config;
      // The refresh token is in an httpOnly cookie that the API reads
      // server-side, so it isn't passed directly. The host has already written
      // the rotated refresh token into that cookie.
      this.#refresh = async () => {
        const session = await authApi.refreshSession();
        return session === null
          ? { kind: "noSession" }
          : { kind: "rotated", session };
      };
      this.#signOutInternal = () => authApi.signOut();
    }

    // Runs last so setups see a fully initialized client.
    this.#registerAmbientSignIns(config.ambientSignIns);
  }

  // --- Observable store API ------------------------------------------------
  // A minimal subscribe/snapshot store any UI framework can consume (React via
  // useSyncExternalStore, others via their own reactivity).

  /**
   * Subscribe to be notified when the {@link AuthState} changes.
   *
   * Subscribers should call {@link getSnapshot} when notified of a change.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Returns the latest {@link AuthState} snapshot.
   */
  getSnapshot = (): AuthState => this.#snapshot;

  /** The current access token, or null. */
  getAccessToken(): string | null {
    return this.#accessToken;
  }

  /** @internal */
  get storage(): NamespacedStorage {
    return this.#storage;
  }

  // --- Ambient sign-in surface ----------------------------------------------

  /**
   * What ambient sign-ins publish, keyed by sign-in id. A setup writes
   * through the scoped view it is handed, and hooks read it back through
   * {@link ambientSignInValues}.
   */
  readonly #ambientValues = new KeyedStore();

  /**
   * A read-only view of the values published under an ambient sign-in's id,
   * for hooks and other bindings to read and subscribe to. Only the sign-in
   * itself can write.
   */
  ambientSignInValues(id: string): SignInValuesReader {
    return this.#ambientValues.forSignInReader(id);
  }

  /** Ambient sign-in onInit callbacks, run once inside {@link init}. */
  readonly #initCallbacks: Array<{ id: string; callback: () => void }> = [];

  /**
   * Run the configured ambient sign-in setups, handing each its scoped
   * views, and collect their onInit callbacks for {@link init} to run.
   * Throws when a sign-in id is invalid or registered twice.
   */
  #registerAmbientSignIns(
    ambientSignIns: AuthClientConfig["ambientSignIns"],
  ): void {
    if (ambientSignIns === undefined) return;
    const seen = new Set<string>();
    for (const { id, setup } of ambientSignIns.signIns) {
      if (!/^[a-zA-Z0-9]+$/.test(id)) {
        throw new Error(
          `Ambient sign-in id "${id}" is invalid; ids must be alphanumeric`,
        );
      }
      if (seen.has(id)) {
        throw new Error(
          `Ambient sign-in id "${id}" is registered twice; each auth ` +
            `method registers once per ConvexAuthProvider`,
        );
      }
      seen.add(id);
      const registration = setup({
        client: this,
        values: this.#ambientValues.forSignIn(id),
        storage: this.#storage.forSignIn(id),
        signInApi: ambientSignIns.signInApi,
        convex: ambientSignIns.convex,
        replaceUrl: ambientSignIns.replaceUrl ?? replaceUrlKeepingState,
      });
      if (registration?.onInit !== undefined) {
        this.#initCallbacks.push({ id, callback: registration.onInit });
      }
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Run ambient sign-in onInit callbacks, load any persisted session from
   * storage, and start listening for cross-tab changes (if applicable).
   * Until this resolves, the client reports `isLoading`.
   *
   * Symmetric and repeatable with {@link dispose}. The callbacks and session
   * load happen once, but the cross-tab listener is (re)attached on every
   * call, so an `init` after a `dispose` fully restores the client.
   */
  async init(): Promise<void> {
    // Attach before the one-time guard so a dispose()/init() cycle re-attaches
    // the listener rather than skipping it. Idempotent, so repeat calls are
    // harmless.
    this.#attachStorageListener();
    if (this.#initialized) return;
    this.#initialized = true;
    // Run ambient sign-in onInit callbacks before anything observable
    // happens, so a withSignInPending call inside one marks loading before
    // the session
    // loads. A callback that throws is logged and skipped, so the others
    // still run and the session still loads.
    for (const { id, callback } of this.#initCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error(
          `[convex-auth] onInit for ambient sign-in "${id}" threw:`,
          error,
        );
      }
    }
    // An initially provided token is considered to be the freshest value, so
    // persist it before the load below reads it back (and so other tabs see
    // it).
    if (this.#initialAccessToken !== null) {
      await this.#storage.set(JWT_STORAGE_KEY, this.#initialAccessToken);
    }
    const [accessToken, refreshToken] = await Promise.all([
      this.#storage.get(JWT_STORAGE_KEY),
      this.#storage.get(REFRESH_TOKEN_STORAGE_KEY),
    ]);
    this.#accessToken = accessToken ?? null;
    this.#refreshToken = refreshToken ?? null;
    this.#log(`init: token is null: ${this.#accessToken === null}`);
    this.#isLoading = false;
    this.#notify();
  }

  /**
   * Detach a registered cross-tab storage listener, if applicable.
   *
   * Call on teardown. Store subscribers are intentionally left in place — each
   * is removed via the unsubscribe returned by {@link subscribe} — so a later
   * {@link init} restores the client without losing its subscribers.
   */
  dispose(): void {
    const target = domEventTarget();
    if (this.#storageListener !== null && target !== null) {
      target.removeEventListener("storage", this.#storageListener);
    }
    this.#storageListener = null;
    // `#adoptedBySignIn` survives: a dispose()/init() cycle (a React remount)
    // can fall between a sign-in's adoption and its follow-up setSession call.
  }

  // --- Public actions ------------------------------------------------------

  /**
   * Adopt the session a method just established. Methods call this after
   * their own sign-in flow returns a session: a full {@link TokenBundle} when
   * the client holds the refresh token (SPA), or an access-only {@link
   * SlimTokenBundle} when the refresh token is in a cookie (SSR).
   *
   * The session is stored under the refresh mutex. A refresh that is under
   * way thus stores its result first, and this session last, whichever
   * response arrived first.
   *
   * To replace a live session with the result of a function call (for example
   * when switching accounts), use {@link switchSession}.
   */
  setSession = async (
    session: TokenBundle | SlimTokenBundle,
  ): Promise<void> => {
    if (this.#adoptedBySignIn.delete(session.accessToken)) {
      return;
    }
    await runWithMutex(this.#lockKey, () =>
      this.#storeFullTokenResult(session),
    );
  };

  /**
   * Run a browser-initiated SSR sign-in call serialized with refreshes,
   * sign-outs, and session switches so the server's cookies and the client's
   * stored access token always reflect the same session.
   *
   * If the call completes with a session, it is adopted before releasing the
   * lock, and the subsequent {@link setSession} call for that exact access
   * token becomes a no-op so it cannot overwrite a newer session later.
   *
   * Because `#lockKey` is not reentrant, callers inside {@link switchSession}
   * must use an unwrapped proxy transport rather than calling `runSsrSignIn`.
   *
   * @internal
   */
  runSsrSignIn = async <Result extends ClientView<SignInEnvelope>>(
    call: () => Promise<Result>,
  ): Promise<Result> => {
    if (this.#mode !== "ssr") {
      return await call();
    }
    return await runWithMutex(this.#lockKey, async () => {
      const result = await call();
      if (result.status === "complete") {
        const tokens = (result as { tokens?: TokenBundle | SlimTokenBundle })
          .tokens;
        if (tokens !== undefined) {
          await this.#storeFullTokenResult(tokens);
          this.#rememberAdoptedBySignIn(tokens.accessToken);
        }
      }
      return result;
    });
  };

  /**
   * Move the client from its current session to another one: call `run`, and
   * apply the {@link SessionSwitchAction} that `sessionOf` reads from its
   * result (`TokenBundle`/`SlimTokenBundle` to adopt, `"signOut"` to clear the
   * session when the backend ended it, or `null` to leave the session as is).
   *
   * Resolves to `{ kind: "ran", result }`, or to `{ kind: "sessionChanged" }`
   * when the client moved to another session first (another tab switched, or
   * a sign-in or sign-out completed). If that happened before this call got
   * its turn, `run` is not called: it would act on a session that the client
   * no longer holds. If it happened while `run` was under way, the result's
   * session change is not applied: the newer session stays. Either way, the
   * result is not returned, since it describes a session the client left.
   *
   * Only one switch (or sign-out) runs at a time, across the tabs that share
   * the storage. Two tabs thus cannot both leave the same session, and a
   * result is never stored over a newer session.
   *
   * Under SSR the refresh mutex is held across `run` as well, serializing
   * switches with refreshes, sign-outs, and ordinary sign-ins through
   * {@link runSsrSignIn} so the cookies and stored access token stay aligned.
   * In a SPA it is held only to apply the session change: `run` calls over the
   * websocket, which can pause for a token that only a refresh holding that
   * mutex can fetch.
   *
   * In a SPA a refresh can therefore cross `run`. If the refresh rotates the
   * old session, the switch adopts the new session after it. If the refresh
   * reports no session (for example because the backend already ended or
   * suspended the old session), that result is held while the switch is under
   * way, and dropped if the switch adopts a new session or clears the session.
   * If the switch leaves the session alone, the held result is applied and the
   * client is signed out. A refresh in another tab that reports no session
   * while this switch is under way leaves the stored tokens alone.
   */
  switchSession = async <Result>(
    run: () => Promise<Result>,
    sessionOf: (result: Result) => SessionSwitchAction,
  ): Promise<{ kind: "ran"; result: Result } | { kind: "sessionChanged" }> => {
    const sessionIdAtCall = this.#snapshot.sessionId;
    return await runWithMutex(this.#switchLockKey, async () => {
      // Another tab may have switched or signed out while this call waited.
      if ((await this.#storedSessionId()) !== sessionIdAtCall) {
        return { kind: "sessionChanged" };
      }
      this.#pendingSwitches++;
      let applied = false;
      try {
        // Apply the switch action, unless a sign-in or external storage change
        // replaced the client's session while `run` was under way. A refresh
        // keeps the session id, and a refresh that found no session is held, so
        // neither counts. Runs under the refresh mutex.
        const applyUnlessReplaced = async (
          action: Exclude<SessionSwitchAction, null>,
        ) => {
          if ((await this.#storedSessionId()) !== sessionIdAtCall) {
            return;
          }
          if (action === "signOut") {
            if (this.#mode === "ssr") {
              try {
                await this.#signOutInternal();
              } catch {
                // Usually means the session is already gone on the server.
              }
            }
            await this.#storeTokens(null);
          } else {
            await this.#storeFullTokenResult(action);
          }
          applied = true;
        };
        let ranResult: { result: Result } | null = null;
        const runAndApply = async (
          apply: (action: Exclude<SessionSwitchAction, null>) => Promise<void>,
        ) => {
          const result = await run();
          ranResult = { result };
          const action = sessionOf(result);
          if (action !== null) {
            await apply(action);
          }
          return action;
        };
        // The mutex is not reentrant, thus under SSR, where this call holds
        // it across `run`, the session change is applied without taking it
        // again.
        let skippedBeforeRun = false;
        const action =
          this.#mode === "ssr"
            ? await runWithMutex(this.#lockKey, async () => {
                // An ordinary SSR sign-in may have held `#lockKey` and replaced
                // the session while we waited to acquire it.
                if ((await this.#storedSessionId()) !== sessionIdAtCall) {
                  skippedBeforeRun = true;
                  return null;
                }
                return await runAndApply(applyUnlessReplaced);
              })
            : await runAndApply((nextAction) =>
                runWithMutex(this.#lockKey, () =>
                  applyUnlessReplaced(nextAction),
                ),
              );
        // A result that changes nothing still describes the session this
        // call started from, so it is stale once another session replaced it.
        const sessionChanged =
          skippedBeforeRun ||
          (action !== null
            ? !applied
            : (await this.#storedSessionId()) !== sessionIdAtCall);
        if (sessionChanged) {
          return { kind: "sessionChanged" };
        }
        return { kind: "ran", result: ranResult!.result };
      } finally {
        this.#pendingSwitches--;
        if (this.#pendingSwitches === 0 && this.#heldNoSession) {
          this.#heldNoSession = false;
          if (!applied) {
            // The held result is about the session this call started from.
            // If a sign-in replaced that session meanwhile, it says nothing
            // about the new one.
            await runWithMutex(this.#lockKey, async () => {
              if ((await this.#storedSessionId()) === sessionIdAtCall) {
                await this.#storeTokens(null);
              }
            });
          }
        }
      }
    });
  };

  /**
   * Run a sign-in completion while reporting `isLoading`. Use it for work
   * that establishes a session without a user action in the current page,
   * like redeeming an OAuth callback code after a redirect, so the UI shows
   * a loading state instead of flashing unauthenticated. The wrapped
   * function should include its {@link setSession} call, so the loading
   * state holds until the client is authenticated.
   */
  withSignInPending = async <T>(fn: () => Promise<T>): Promise<T> => {
    this.#pendingSignIns++;
    this.#notify();
    try {
      return await fn();
    } finally {
      this.#pendingSignIns--;
      this.#notify();
    }
  };

  /**
   * Revoke the current session on the server and clear it locally.
   *
   * Takes turns with {@link switchSession} so a sign-out during a switch
   * revokes the session that is current when sign-out gets its turn, and a
   * late switch response cannot reinstall cookies after sign-out clears them.
   */
  signOut = async (): Promise<void> => {
    await this.#signOutLocked();
  };

  /**
   * Sign out only if the stored session is still `sessionId`. Used by
   * `SessionWatcher` so a stale revocation notice for an earlier session
   * cannot sign out a newer session that just replaced it.
   *
   * @internal
   */
  signOutIfSession = async (sessionId: string): Promise<void> => {
    await this.#signOutLocked(sessionId);
  };

  async #signOutLocked(expectedSessionId?: string): Promise<void> {
    await runWithMutex(this.#switchLockKey, async () => {
      if (this.#mode === "ssr") {
        await runWithMutex(this.#lockKey, async () => {
          if (
            expectedSessionId !== undefined &&
            (await this.#storedSessionId()) !== expectedSessionId
          ) {
            return;
          }
          try {
            await this.#signOutInternal();
          } catch {
            // Usually means we were already signed out, which is fine.
          }
          this.#log("signed out, erasing tokens");
          await this.#storeTokens(null);
        });
        return;
      }

      // An explicit SPA sign-out erases whatever is stored once revocation
      // returns, as it did before the conditional path existed: the user
      // asked to be signed out of this client.
      if (expectedSessionId === undefined) {
        try {
          await this.#signOutInternal();
        } catch {
          // Usually means we were already signed out, which is fine.
        }
        this.#log("signed out, erasing tokens");
        await runWithMutex(this.#lockKey, () => this.#storeTokens(null));
        return;
      }

      // Conditional SPA sign-out (e.g. SessionWatcher): capture the matching
      // refresh token under `#lockKey`, release `#lockKey` for the network
      // call so a websocket refresh cannot deadlock, then recheck the stored
      // session under `#lockKey` before clearing so a sign-in that completed
      // during the await is preserved.
      const captured = await runWithMutex(this.#lockKey, async () => {
        if ((await this.#storedSessionId()) !== expectedSessionId) {
          return { matched: false as const };
        }
        return {
          matched: true as const,
          refreshToken: await this.#currentRefreshToken(),
        };
      });
      if (!captured.matched) {
        return;
      }
      try {
        await this.#signOutInternal(captured.refreshToken);
      } catch {
        // Usually means we were already signed out, which is fine.
      }
      await runWithMutex(this.#lockKey, async () => {
        if ((await this.#storedSessionId()) !== expectedSessionId) {
          return;
        }
        this.#log("signed out, erasing tokens");
        await this.#storeTokens(null);
      });
    });
  }

  #rememberAdoptedBySignIn(accessToken: string): void {
    this.#adoptedBySignIn.add(accessToken);
    if (this.#adoptedBySignIn.size > MAX_REMEMBERED_SIGN_IN_TOKENS) {
      const oldest = this.#adoptedBySignIn.values().next().value;
      if (oldest !== undefined) {
        this.#adoptedBySignIn.delete(oldest);
      }
    }
  }

  /**
   * The function handed to Convex's `ConvexProviderWithAuth`.
   *
   * Returns a cached access token, or fetches a new token if
   * `forceRefreshToken` is `true`.
   */
  fetchAccessToken = async ({
    forceRefreshToken,
  }: {
    forceRefreshToken: boolean;
  }): Promise<string | null> => {
    if (!forceRefreshToken) {
      return this.#accessToken;
    }
    const tokenBeforeLock = this.#accessToken;
    return await runWithMutex(this.#lockKey, async () => {
      // Another tab may have refreshed while we waited for the lock; if so,
      // use its result rather than rotating again.
      if (this.#accessToken !== tokenBeforeLock) {
        this.#log(`using token refreshed by another tab`);
        return this.#accessToken;
      }
      const result = await retryOnNetworkError(
        () => this.#refresh(),
        (message) => this.#log(`refresh: ${message}`),
      );
      await this.#handleRefresh(result);
      return this.#accessToken;
    });
  };

  // --- Internals -----------------------------------------------------------

  /**
   * The id of the session that the stored access token belongs to, or `null`
   * when none is stored. The storage is what the tabs share, so it knows about
   * a session that another tab stored before this tab heard of it.
   */
  async #storedSessionId(): Promise<string | null> {
    const accessToken = (await this.#storage.get(JWT_STORAGE_KEY)) ?? null;
    return accessToken === null ? null : sessionIdOfAccessToken(accessToken);
  }

  /** The authoritative refresh token: storage (shared across tabs) then memory. */
  async #currentRefreshToken(): Promise<string | null> {
    return (
      (await this.#storage.get(REFRESH_TOKEN_STORAGE_KEY)) ?? this.#refreshToken
    );
  }

  /**
   * Persist the outcome of a refresh.
   *
   * This either extends/updates the signed in state via new tokens or
   * transitions the client to signed out.
   */
  async #handleRefresh(result: RefreshOutcome): Promise<void> {
    switch (result.kind) {
      case "noSession":
        // A session switch that is under way decides what this means: see
        // `switchSession`.
        if (this.#pendingSwitches > 0) {
          this.#heldNoSession = true;
          return;
        }
        // The switch may be under way in another tab. Clearing the storage
        // that the tabs share would make that tab discard the session it is
        // about to store, and sign every tab out. So leave the tokens: the
        // other tab replaces them when its switch succeeds. If it fails, they
        // belong to a session that is gone, and the next refresh, with no
        // switch under way, clears them.
        //
        // The lock is named after the storage namespace. With a storage that
        // each tab has to itself (`sessionStorage`), a switch in an unrelated
        // tab thus delays this tab's sign-out the same way, until its next
        // refresh.
        if (await isMutexHeld(this.#switchLockKey)) {
          return;
        }
        await this.#storeTokens(null);
        return;
      case "rotated":
        await this.#storeFullTokenResult(result.session);
        return;
    }
  }

  /**
   * Store the tokens for a sign-in or refresh result, persisting it by its shape:
   *  - a full {@link TokenBundle} stores both refresh and access tokens
   *  - a {@link SlimTokenBundle} stores just the access token
   *  - `null` clears the session
   */
  async #storeFullTokenResult(
    result: TokenBundle | SlimTokenBundle | null,
  ): Promise<void> {
    if (result === null) {
      await this.#storeTokens(null);
      return;
    }
    // Which shape arrives is a property of the session model, so a mismatch is
    // a wiring bug. Both directions fail loudly rather than degrading, because
    // both degrade in ways that are hard to trace back here.
    if (hasRefreshToken(result)) {
      // Storing this would put a long-lived credential in browser storage,
      // which is the thing the SSR model exists to prevent.
      if (this.#mode === "ssr") {
        throw new Error(
          "[convex-auth] Received a refresh token in an SSR response. The " +
            "auth proxy did not move it into the httpOnly cookie; refusing " +
            "to persist it in browser storage.",
        );
      }
      await this.#storeTokens(result);
    } else {
      // Nothing could rotate the session, so it would die at the first
      // access-token expiry and log the user out with no explanation.
      if (this.#mode === "spa") {
        throw new Error(
          "[convex-auth] Received a session with no refresh token in SPA " +
            "mode. Without one the session cannot be rotated and would " +
            "expire silently.",
        );
      }
      await this.#storeAccessOnly(result);
    }
  }

  /**
   * Stores (or clears in the case of a `null` bundle) the access and refresh
   * tokens.
   */
  async #storeTokens(bundle: TokenBundle | null): Promise<void> {
    if (bundle === null) {
      this.#accessToken = null;
      this.#refreshToken = null;
      await this.#storage.remove(JWT_STORAGE_KEY);
      await this.#storage.remove(REFRESH_TOKEN_STORAGE_KEY);
    } else {
      this.#accessToken = bundle.accessToken;
      this.#refreshToken = bundle.refreshToken;
      await this.#storage.set(JWT_STORAGE_KEY, bundle.accessToken);
      await this.#storage.set(REFRESH_TOKEN_STORAGE_KEY, bundle.refreshToken);
    }
    this.#isLoading = false;
    this.#notify();
  }

  /**
   * Stores just the access token and notifies subscribers. Only SSR gets here:
   * the refresh token lives in the host's httpOnly cookie.
   */
  async #storeAccessOnly(session: { accessToken: string }): Promise<void> {
    // Null out/remove any existing refresh token. It shouldn't be set unless
    // this was somehow a client instance configured for SPA use being
    // "upgraded" to SSR use.
    this.#refreshToken = null;
    await this.#storage.remove(REFRESH_TOKEN_STORAGE_KEY);

    this.#accessToken = session.accessToken;
    await this.#storage.set(JWT_STORAGE_KEY, session.accessToken);
    this.#isLoading = false;
    this.#notify();
  }

  #attachStorageListener(): void {
    const target = domEventTarget();
    // This null check guards React Native, where cross-tab storage isn't a thing.
    if (target === null) return;
    if (this.#storageListener !== null) return;
    const jwtKey = this.#storage.key(JWT_STORAGE_KEY);
    const refreshKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
    const listener = (event: StorageEvent) => {
      // Only react to our own storage area (e.g. ignore sessionStorage events
      // when we use localStorage). Keys arrive as separate events, so we handle
      // the JWT and refresh keys independently and never write back here (that
      // would loop).
      if (event.storageArea !== this.#storage.storage) return;
      if (event.key === jwtKey) {
        this.#accessToken = event.newValue;
        this.#log(`synced access token, is null: ${event.newValue === null}`);
        this.#isLoading = false;
        this.#notify();
      } else if (event.key === refreshKey) {
        this.#refreshToken = event.newValue;
      }
    };
    target.addEventListener("storage", listener);
    this.#storageListener = listener;
  }

  #notify(): void {
    this.#snapshot = {
      // Loading until the persisted session has been read, and again while a
      // sign-in completion is pending (see withSignInPending).
      isLoading: this.#isLoading || this.#pendingSignIns > 0,
      isAuthenticated: this.#accessToken !== null,
      token: this.#accessToken,
      sessionId:
        this.#accessToken === null
          ? null
          : sessionIdOfAccessToken(this.#accessToken),
    };
    for (const listener of this.#listeners) listener();
  }

  #log(message: string): void {
    if (this.#verbose) {
      console.debug(`${new Date().toISOString()} [convex-auth] ${message}`);
    }
  }
}
