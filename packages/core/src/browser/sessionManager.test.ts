import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  RefreshResult,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
import { unusedConvex } from "../react/testSignInApi.ts";
import {
  AuthClient,
  INITIAL_AUTH_STATE,
  SpaAuthApi,
  SsrAuthApi,
} from "./sessionManager.ts";
import type {
  AuthSignInApi,
  ConvexClientApi,
  SignInFunction,
} from "./signInApi.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from "./storage.ts";

const NAMESPACE = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

// Tests below swap in a stub `window` to simulate other runtimes. The
// edge-runtime environment these tests run in supplies its own (`window ===
// globalThis`, with working DOM event APIs), so we put that back afterwards.
const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreWindow(): void {
  if (ORIGINAL_WINDOW === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
  }
}

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 0,
    userId: "user-1",
  };
}

/** A `rotated` refresh outcome carrying `bundle(n)`. */
function rotated(n: number): RefreshResult {
  return { kind: "rotated", tokens: bundle(n) };
}

// `storage` is typed as the interface rather than the concrete default so the
// async-store tests below can pass their own implementation.
function makeClient(
  authApi: Partial<SpaAuthApi> = {},
  storage: TokenStorage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "spa",
    convex: unusedConvex,
    url: NAMESPACE,
    authApi: {
      refreshSession: async () => ({ kind: "noSession" }),
      signOut: async () => {},
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

function makeSsrClient(
  authApi: Partial<SsrAuthApi> = {},
  storage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "ssr",
    convex: unusedConvex,
    url: NAMESPACE,
    signInApi: SIGN_IN_API,
    authApi: {
      refreshSession: async () => null,
      signOut: async () => {},
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

describe("AuthClient", () => {
  afterEach(restoreWindow);

  test("starts unauthenticated with an empty store", async () => {
    const { client } = makeClient();
    expect(client.getSnapshot()).toMatchObject({ isLoading: true });
    await client.init();
    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: false,
      token: null,
    });
  });

  test("setSession authenticates and persists under namespaced keys", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(bundle(1));

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
    expect(client.getAccessToken()).toBe("access-1");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-1",
    );
  });

  test("hydrates a persisted session on init", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const { client } = makeClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("fetchAccessToken returns the cached token without forcing", async () => {
    const refreshSession = vi.fn(async () => rotated(2));
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: false });
    expect(token).toBe("access-1");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  test("forced fetch rotates the session via refreshSession", async () => {
    const refreshSession = vi.fn(async (rt: string) => {
      expect(rt).toBe("refresh-1");
      return rotated(2);
    });
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-2",
    );
  });

  test("a refresh that fails keeps the stored refresh token for the next try", async () => {
    // The server leaves the presented token valid until its successor is used,
    // so a refresh whose response never arrives is retried with the same token.
    const refreshSession = vi
      .fn<(rt: string) => Promise<RefreshResult>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(rotated(2));
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    await expect(
      client.fetchAccessToken({ forceRefreshToken: true }),
    ).rejects.toThrow("response lost");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-1",
    );

    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
      "access-2",
    );
    expect(refreshSession).toHaveBeenNthCalledWith(2, "refresh-1");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-2",
    );
  });

  test("a noSession refresh result clears the session", async () => {
    const { client, storage } = makeClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("concurrent forced fetches collapse to a single refresh", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const refreshSession = vi.fn(async () => {
      await promise;
      return rotated(2);
    });
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const pending = [
      client.fetchAccessToken({ forceRefreshToken: true }),
      client.fetchAccessToken({ forceRefreshToken: true }),
      client.fetchAccessToken({ forceRefreshToken: true }),
    ];
    resolve();
    const results = await Promise.all(pending);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(results).toEqual(["access-2", "access-2", "access-2"]);
  });

  test("signOut revokes on the server and clears locally", async () => {
    const signOut = vi.fn(async (rt: string) => {
      expect(rt).toBe("refresh-1");
    });
    const { client } = makeClient({ signOut });
    await client.init();
    await client.setSession(bundle(1));

    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });

  test("syncs sign-out from another tab via storage events", async () => {
    const listeners: Array<(event: StorageEvent) => void> = [];
    const storage = new InMemoryStorage();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.push(l),
      removeEventListener: () => {},
    };

    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);

    // Another tab cleared the JWT key.
    listeners.forEach((l) =>
      l({
        storageArea: storage,
        key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
        newValue: null,
      } as unknown as StorageEvent),
    );

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });

  test("works where `window` exists without DOM event APIs (React Native)", async () => {
    // React Native's global object *is* `window`, but it has no
    // addEventListener/removeEventListener. Cross-tab sync is skipped rather
    // than throwing when the provider mounts.
    (globalThis as { window?: unknown }).window = { navigator: {} };

    const { client } = makeClient();
    await expect(client.init()).resolves.toBeUndefined();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(() => client.dispose()).not.toThrow();
  });

  test("works where there is no `window` at all (server runtime)", async () => {
    delete (globalThis as { window?: unknown }).window;

    const { client } = makeClient();
    await expect(client.init()).resolves.toBeUndefined();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(() => client.dispose()).not.toThrow();
  });

  test("withSignInPending turns loading on while its call is pending", async () => {
    const { client } = makeClient();
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(false);

    const { promise, resolve } = Promise.withResolvers<string>();
    const pending = client.withSignInPending(() => promise);
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve("done");
    await expect(pending).resolves.toBe("done");
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("withSignInPending clears loading when the completion throws", async () => {
    const { client } = makeClient();
    await client.init();

    await expect(
      client.withSignInPending(async () => {
        throw new Error("redemption failed");
      }),
    ).rejects.toThrow("redemption failed");
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("overlapping completions keep loading until the last settles", async () => {
    const { client } = makeClient();
    await client.init();

    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const pending = [
      client.withSignInPending(() => first.promise),
      client.withSignInPending(() => second.promise),
    ];

    first.resolve();
    await pending[0];
    expect(client.getSnapshot().isLoading).toBe(true);

    second.resolve();
    await pending[1];
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("re-attaches the storage listener when init runs after dispose", async () => {
    const listeners = new Set<(event: StorageEvent) => void>();
    const storage = new InMemoryStorage();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.add(l),
      removeEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.delete(l),
    };

    const { client } = makeClient({}, storage);
    // init/dispose is a symmetric, repeatable lifecycle: an init() after a
    // dispose() must restore cross-tab sync. (A consumer that re-mounts the same
    // client — e.g. React StrictMode — drives exactly this sequence; that path
    // is covered end-to-end in the React bindings' tests.)
    await client.init();
    client.dispose();
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(listeners.size).toBe(1);

    // Another tab cleared the JWT key.
    listeners.forEach((l) =>
      l({
        storageArea: storage,
        key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
        newValue: null,
      } as unknown as StorageEvent),
    );

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });
});

/** A stub Convex client whose calls are mocks. */
function stubConvex(url?: string) {
  const mutation = vi.fn();
  const action = vi.fn();
  const convex = { mutation, action } as unknown as ConvexClientApi & {
    url?: string;
  };
  if (url !== undefined) convex.url = url;
  return { convex, mutation, action };
}

function makeClientWith(
  convex: ConvexClientApi,
  signInApi?: AuthSignInApi,
): AuthClient {
  return new AuthClient({
    mode: "spa",
    convex,
    url: NAMESPACE,
    signInApi,
    authApi: {
      refreshSession: async () => ({ kind: "noSession" }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
}

describe("AuthClient Convex client and sign-in API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sign-in functions run on the Convex client without a sign-in API", async () => {
    const { convex, mutation, action } = stubConvex();
    mutation.mockResolvedValue("from mutation");
    action.mockResolvedValue("from action");
    const client = makeClientWith(convex);

    await expect(client.signIn.mutation(ENVELOPE_REF, {})).resolves.toBe(
      "from mutation",
    );
    await expect(client.signIn.action(ENVELOPE_ACTION_REF, {})).resolves.toBe(
      "from action",
    );
    expect(mutation).toHaveBeenCalledWith(SIGN_IN_REF, {});
    expect(action).toHaveBeenCalledWith(SIGN_IN_REF, {});
  });

  test("sign-in functions run on the sign-in API when one is set", async () => {
    const { convex, mutation } = stubConvex();
    SIGN_IN_MUTATION.mockResolvedValueOnce("from sign-in api");
    const client = makeClientWith(convex, SIGN_IN_API);

    await expect(client.signIn.mutation(ENVELOPE_REF, {})).resolves.toBe(
      "from sign-in api",
    );
    expect(SIGN_IN_MUTATION).toHaveBeenCalledWith(SIGN_IN_REF, {});
    expect(mutation).not.toHaveBeenCalled();
  });

  test("convex is the client from the config", () => {
    const { convex } = stubConvex();
    expect(makeClientWith(convex).convex).toBe(convex);
  });

  test("setConvex replaces the client and notifies subscribers", async () => {
    const first = stubConvex(NAMESPACE);
    const second = stubConvex(`${NAMESPACE}/`);
    second.mutation.mockResolvedValue("second");
    const client = makeClientWith(first.convex);
    const snapshot = client.getSnapshot();
    const listener = vi.fn();
    client.subscribe(listener);

    client.setConvex(second.convex);

    expect(client.convex).toBe(second.convex);
    expect(listener).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toBe(snapshot);
    await expect(client.signIn.mutation(ENVELOPE_REF, {})).resolves.toBe(
      "second",
    );
    expect(first.mutation).not.toHaveBeenCalled();
  });

  test("a Convex client for another deployment is rejected", () => {
    const other = stubConvex("https://other-animal-456.convex.cloud");
    expect(() => makeClientWith(other.convex)).toThrow(
      /Build a new auth client for a different deployment/,
    );
    const { convex } = stubConvex(NAMESPACE);
    const client = makeClientWith(convex);
    expect(() => client.setConvex(other.convex)).toThrow(
      /Build a new auth client for a different deployment/,
    );
    expect(client.convex).toBe(convex);
  });

  test("signInStorage scopes keys by method and namespace", async () => {
    const storage = new InMemoryStorage();
    const client = new AuthClient({
      mode: "spa",
      convex: unusedConvex,
      url: NAMESPACE,
      authApi: {
        refreshSession: async () => ({ kind: "noSession" }),
        signOut: async () => {},
      },
      storage,
      storageNamespace: NAMESPACE,
    });
    await client.signInStorage("oauth").set("flow", "f1");
    expect(storage.getItem(`__convexAuthProvider_oauth_flow_${SUFFIX}`)).toBe(
      "f1",
    );
    expect(() => client.signInStorage("pass-key")).toThrow(
      /"pass-key" is invalid/,
    );
  });
});

/** The mutation stub behind {@link SIGN_IN_API}. */
const SIGN_IN_MUTATION = vi.fn();

/** A stub sign-in api for the clients below. */
const SIGN_IN_API = {
  mutation: SIGN_IN_MUTATION,
  action: vi.fn(),
} as unknown as AuthSignInApi;

/** A reference to hand the stub. Its path is never resolved. */
const SIGN_IN_REF = makeFunctionReference<"mutation">("auth:probeSignIn");

/** {@link SIGN_IN_REF} typed as a function that returns the sign-in envelope. */
const ENVELOPE_REF = SIGN_IN_REF as unknown as SignInFunction<"mutation">;

/** {@link ENVELOPE_REF} typed as an action. */
const ENVELOPE_ACTION_REF = SIGN_IN_REF as unknown as SignInFunction<"action">;

describe("AuthClient sign-in completion during the session load", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("withSignInPending entered before init holds loading past the session load", async () => {
    // What an OAuth callback does: a mount effect starts a sign-in whose
    // network call has not finished by the time init finishes loading the
    // session. Without the withSignInPending wrapper the client would report
    // signed out until the call finished, sending the user to a sign-in
    // screen while they are signing in.
    const signIn = Promise.withResolvers<void>();
    const { client } = makeClient();
    SIGN_IN_MUTATION.mockReturnValueOnce(signIn.promise);
    const pending = client.withSignInPending(async () => {
      await SIGN_IN_API.mutation(ENVELOPE_REF, {});
      await client.setSession(bundle(1));
    });

    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);

    signIn.resolve();
    await pending;
    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("a sign-out while init reads storage keeps the user signed out", async () => {
    // The access token read starts before the sign-out and answers after it
    // clears the session, with the token it read.
    const read = Promise.withResolvers<void>();
    const storage = new InMemoryStorage();
    const jwtKey = `${JWT_STORAGE_KEY}_${SUFFIX}`;
    storage.setItem(jwtKey, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const getItem = storage.getItem.bind(storage);
    const delayed: TokenStorage = {
      getItem: async (key) => {
        const value = getItem(key);
        if (key === jwtKey) await read.promise;
        return value;
      },
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };
    const { client } = makeClient({}, delayed);

    const initialized = client.init();
    const signedOut = client.signOut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    read.resolve();
    await Promise.all([initialized, signedOut]);

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: false,
      token: null,
    });
  });

  test("a session set while init reads storage is kept", async () => {
    // The storage read starts before the session is set and answers after,
    // with the empty storage it read.
    const read = Promise.withResolvers<void>();
    const storage = new InMemoryStorage();
    const getItem = storage.getItem.bind(storage);
    const delayed: TokenStorage = {
      getItem: async (key) => {
        const value = getItem(key);
        await read.promise;
        return value;
      },
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key),
    };
    const { client } = makeClient({}, delayed);

    const initialized = client.init();
    const stored = client.setSession(bundle(1));
    read.resolve();
    await Promise.all([initialized, stored]);

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
  });
});

/**
 * Returns a {@link SlimTokenBundle} which is the typical auth response from
 * an SSR integration.
 */
function ssrAuthResult(n: number): SlimTokenBundle {
  return {
    accessToken: `access-${n}`,
    userId: "user-1",
  };
}

describe("AuthClient (SSR)", () => {
  afterEach(restoreWindow);

  test("setSession adopts an access-only session, storing no refresh token", async () => {
    const { client, storage } = makeSsrClient();
    await client.init();
    await client.setSession(ssrAuthResult(1));

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
    // The refresh token lives in a server-only cookie — never in JS storage.
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("hydrates a session from just the access token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const { client } = makeSsrClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("forced fetch refreshes via the token-less API call", async () => {
    const refreshSession = vi.fn(async () => ssrAuthResult(2));
    const { client, storage } = makeSsrClient({ refreshSession });
    await client.init();
    await client.setSession(ssrAuthResult(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    // No refresh token in JS, so the API is called with no arguments (it reads
    // the cookie server-side).
    expect(refreshSession).toHaveBeenCalledWith();
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-2");
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("a null refresh clears the session", async () => {
    const { client, storage } = makeSsrClient({
      refreshSession: async () => null,
    });
    await client.init();
    await client.setSession(ssrAuthResult(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("signOut calls the API with no arguments and clears locally", async () => {
    const signOut = vi.fn(async () => {});
    const { client } = makeSsrClient({ signOut });
    await client.init();
    await client.setSession(ssrAuthResult(1));

    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });

  test("initialAccessToken wins over a persisted token and is stored", async () => {
    // The SSR host may have refreshed on the client's behalf, so its token is
    // fresher than anything already in storage — it should win and persist.
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "stale-access");
    const { client } = makeSsrClient({}, storage);
    await client.init({ initialAccessToken: "access-ssr" });

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-ssr",
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-ssr");
  });

  test("clears refresh token if present", async () => {
    const refreshSession = vi.fn(async () => ssrAuthResult(2));
    const storage = new InMemoryStorage();
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const { client } = makeSsrClient({ refreshSession }, storage);
    await client.init();
    await client.fetchAccessToken({ forceRefreshToken: true });
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      null,
    );
  });
});

/**
 * A {@link TokenStorage} whose every method returns a promise, like in React
 * Native.
 */
class AsyncTokenStorage implements TokenStorage {
  readonly entries = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    await Promise.resolve();
    return this.entries.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    await Promise.resolve();
    this.entries.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    await Promise.resolve();
    this.entries.delete(key);
  }
}

describe("AuthClient (async storage)", () => {
  afterEach(restoreWindow);

  test("a repeat init resolves when the first one has loaded the session", async () => {
    const storage = new AsyncTokenStorage();
    storage.entries.set(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const { client } = makeClient({}, storage);

    void client.init();
    await client.init();

    expect(client.getSnapshot()).toMatchObject({
      isLoading: false,
      isAuthenticated: true,
    });
  });

  test("hydrates a persisted session on init", async () => {
    // The case that matters on React Native: a session survives an app
    // restart, rather than the user landing on the sign-in screen every launch.
    const storage = new AsyncTokenStorage();
    storage.entries.set(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.entries.set(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");

    const { client } = makeClient({}, storage);
    await client.init();

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("reports loading until the store resolves", async () => {
    const storage = new AsyncTokenStorage();
    storage.entries.set(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");

    const { client } = makeClient({}, storage);
    const initialized = client.init();
    // A store that answers asynchronously must not be reported as "signed out"
    // in the meantime — that flash would bounce the user to a sign-in screen.
    expect(client.getSnapshot()).toEqual(INITIAL_AUTH_STATE);

    await initialized;
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true });
  });

  test("persists, rotates and clears through the async store", async () => {
    const refreshSession = vi.fn(async (rt: string) => {
      // The rotated token must be read back out of the async store, not just
      // held in memory.
      expect(rt).toBe("refresh-1");
      return rotated(2);
    });
    const storage = new AsyncTokenStorage();
    const { client } = makeClient({ refreshSession }, storage);
    await client.init();

    await client.setSession(bundle(1));
    expect(storage.entries.get(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "access-1",
    );
    expect(storage.entries.get(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-1",
    );

    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
      "access-2",
    );
    expect(storage.entries.get(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-2",
    );

    await client.signOut();
    expect(storage.entries.size).toBe(0);
  });
});
