/**
 * A framework-agnostic storage abstraction for auth tokens (and any other
 * client-side secrets a client library needs to persist).
 *
 * In browsers, both `localStorage` and `sessionStorage` satisfy
 * {@link TokenStorage} directly. `sessionStorage` gives each tab its own
 * session; `localStorage` shares one across tabs. In React Native, wrap
 * something like `expo-secure-store`.
 *
 * Nothing here depends on React or Convex, so other client libraries can build
 * on it.
 */
import { clientStepReportsEnabled, reportClientStep } from "./steps.ts";

/**
 * Read/write/delete string values by key. Every method may be synchronous or
 * return a promise, so async stores (e.g. React Native secure storage) work
 * without ceremony.
 */
export interface TokenStorage {
  /** Read a value. */
  getItem: (
    key: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
  /** Write a value. */
  setItem: (key: string, value: string) => void | Promise<void>;
  /** Remove a value. */
  removeItem: (key: string) => void | Promise<void>;
}

/** Storage key for the current access token (a JWT). */
export const JWT_STORAGE_KEY = "__convexAuthJWT";
/** Storage key for the current (rotating) refresh token. */
export const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";

/**
 * An in-memory {@link TokenStorage}, used as a fallback when no persistent
 * storage is available (SSR, or a non-browser runtime). Sessions stored here do
 * not survive a reload.
 */
export class InMemoryStorage implements TokenStorage {
  private store: Record<string, string> = {};
  getItem(key: string) {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string) {
    this.store[key] = value;
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}

let warnedAboutInMemoryFallback = false;

/** The part that reports the steps of this module. */
const STEPS = "module:browser/storage";

/**
 * Report a read, with whether it found a value, once the value is known. The
 * value itself is never reported.
 *
 * The reports of this module name a key as the logical key and the namespace
 * of a {@link NamespacedStorage}, whose stored key is `<key>_<namespace>`.
 * Together the stored key mixes digits and both cases, and a tool that scrubs
 * random-looking text from the reports would take it for a token.
 */
function reportRead(
  where: { key: string; namespace: string },
  value: ReturnType<TokenStorage["getItem"]>,
): void {
  const report = (found: string | undefined | null) =>
    reportClientStep(STEPS, "storage.read", {
      ...where,
      found: found !== null && found !== undefined,
    });
  if (value instanceof Promise) {
    value.then(report, () => {});
  } else {
    report(value);
  }
}

/** Exposed for tests; the warning is otherwise once per process. */
export function resetInMemoryFallbackWarning(): void {
  warnedAboutInMemoryFallback = false;
}

/**
 * The default storage: the browser's `localStorage` when available, otherwise
 * an {@link InMemoryStorage}. Callers that need cross-tab sessions, React
 * Native, or per-tab sessions should pass their own storage instead.
 */
export function defaultStorage(): TokenStorage {
  if (typeof window !== "undefined") {
    if (window.localStorage) return window.localStorage;
    // React Native has a window with no `localStorage`. Warn once here that
    // in-memory storage will be used until another storage implementation is
    // supplied.
    if (!warnedAboutInMemoryFallback) {
      warnedAboutInMemoryFallback = true;
      console.warn(
        "[convex-auth] This runtime has no `localStorage`, so the session is " +
          "being kept in memory and will not survive an app restart. Pass a " +
          "`storage` implementation to your auth provider to persist it. " +
          "For React Native, that would be one backed by something like " +
          "`expo-secure-store`.",
      );
    }
  }
  return new InMemoryStorage();
}

/**
 * A read/write view over a {@link NamespacedStorage} for one ambient sign-in,
 * with every key prefixed by that sign-in's id. The shape handed to an
 * ambient sign-in's setup.
 *
 * Keys are stored as-is, so use only characters in `[A-Za-z0-9._-]` to stay
 * compatible with React Native storage backends like Expo SecureStore.
 */
export type SignInStorage = {
  /** Read a value. */
  get(key: string): ReturnType<TokenStorage["getItem"]>;
  /** Write a value. */
  set(key: string, value: string): ReturnType<TokenStorage["setItem"]>;
  /** Remove a value. */
  remove(key: string): ReturnType<TokenStorage["removeItem"]>;
};

/**
 * A view over a {@link TokenStorage} that suffixes every key with a sanitized
 * namespace. Keying by (e.g.) the deployment URL keeps tokens for different
 * deployments from colliding when they share one origin's `localStorage` (the
 * classic dev-vs-prod-on-localhost case). Two clients sharing a namespace share
 * a session; distinct namespaces isolate them.
 *
 * The sanitized suffix is best effort. Namespaces with the same alphanumeric
 * characters map to the same keys.
 */
export class NamespacedStorage {
  /** The wrapped storage. Exposed so callers can compare a `StorageEvent`'s
   * `storageArea` against it for cross-tab sync. */
  readonly storage: TokenStorage;
  /** The sanitized namespace that ends each stored key. */
  readonly namespace: string;

  constructor(storage: TokenStorage, namespace: string) {
    this.storage = storage;
    // Non-alphanumeric characters are stripped for React Native compatibility.
    this.namespace = namespace.replace(/[^a-zA-Z0-9]/g, "");
  }

  /** The fully-qualified (namespaced) key for a logical key. */
  key(key: string): string {
    return `${key}_${this.namespace}`;
  }

  get(key: string) {
    const value = this.storage.getItem(this.key(key));
    if (clientStepReportsEnabled()) {
      reportRead({ key, namespace: this.namespace }, value);
    }
    return value;
  }
  set(key: string, value: string) {
    reportClientStep(STEPS, "storage.write", {
      key,
      namespace: this.namespace,
    });
    return this.storage.setItem(this.key(key), value);
  }
  remove(key: string) {
    reportClientStep(STEPS, "storage.remove", {
      key,
      namespace: this.namespace,
    });
    return this.storage.removeItem(this.key(key));
  }

  /**
   * A {@link SignInStorage} for the ambient sign-in registered under `id`,
   * mapping `key` to `__convexAuthProvider_<id>_<key>` before the namespace
   * suffix. A sign-in's keys can then never collide with the core token keys
   * or another sign-in's.
   */
  forSignIn(id: string): SignInStorage {
    const prefix = `__convexAuthProvider_${id}_`;
    return {
      get: (key) => this.get(`${prefix}${key}`),
      set: (key, value) => this.set(`${prefix}${key}`, value),
      remove: (key) => this.remove(`${prefix}${key}`),
    };
  }
}
