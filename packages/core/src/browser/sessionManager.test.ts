import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  RefreshResult,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "./ambientSignInClient.ts";
import { UNREADABLE_SESSION_ID } from "./sessionId.ts";
import {
  AuthClient,
  INITIAL_AUTH_STATE,
  SpaAuthApi,
  SsrAuthApi,
} from "./sessionManager.ts";
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
  extra: { initialAccessToken?: string | null } = {},
) {
  const client = new AuthClient({
    mode: "ssr",
    authApi: {
      refreshSession: async () => null,
      signOut: async () => {},
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
    ...extra,
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
      sessionId: null,
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
      sessionId: UNREADABLE_SESSION_ID,
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

/** The mutation stub behind {@link SIGN_IN_API}. */
const SIGN_IN_MUTATION = vi.fn();

/** A stub sign-in api handed to every setup below. */
const SIGN_IN_API = {
  mutation: SIGN_IN_MUTATION,
  action: vi.fn(),
} as unknown as AuthSignInApi;

/** A reference to hand the stub. Its path is never resolved. */
const SIGN_IN_REF = makeFunctionReference<"mutation">("auth:probeSignIn");

/** An {@link AuthClient} constructed with the given ambient sign-ins. */
function makeClientWithSignIns(
  signIns: ReadonlyArray<AmbientSignInClient>,
  storage: TokenStorage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" }),
      signOut: async () => {},
    },
    storage,
    storageNamespace: NAMESPACE,
    ambientSignIns: {
      signIns,
      signInApi: SIGN_IN_API,
      convex: { mutation: vi.fn() },
    },
  });
  return { client, storage };
}

describe("AuthClient ambient sign-ins", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("throws when two sign-ins share an id", () => {
    expect(() =>
      makeClientWithSignIns([
        { id: "oauth", setup: () => {} },
        { id: "oauth", setup: () => {} },
      ]),
    ).toThrow(/"oauth" is registered twice/);
  });

  test("throws when a sign-in id is not alphanumeric", () => {
    expect(() =>
      makeClientWithSignIns([{ id: "pass-key", setup: () => {} }]),
    ).toThrow(/"pass-key" is invalid/);
  });

  test("scoped value writes land under the sign-in id", () => {
    const { client } = makeClientWithSignIns([
      {
        id: "oauth",
        setup: (ctx) => {
          ctx.values.set("actions", "registered");
        },
      },
    ]);
    expect(client.ambientSignInValues("oauth").get<string>("actions")).toBe(
      "registered",
    );
  });

  test("scoped storage writes land under the sign-in prefix", () => {
    const storage = new InMemoryStorage();
    makeClientWithSignIns(
      [
        {
          id: "oauth",
          setup: (ctx) => {
            void ctx.storage.set("verifier", "v1");
          },
        },
      ],
      storage,
    );
    // Provider prefix first, then the client's deployment namespacing.
    expect(
      storage.getItem(
        new NamespacedStorage(storage, NAMESPACE).key(
          "__convexAuthProvider_oauth_verifier",
        ),
      ),
    ).toBe("v1");
  });

  test("every setup receives the same sign-in api and client", () => {
    const received: Array<{ signInApi: AuthSignInApi; client: AuthClient }> =
      [];
    const { client } = makeClientWithSignIns([
      {
        id: "a",
        setup: (ctx) => {
          received.push({ signInApi: ctx.signInApi, client: ctx.client });
        },
      },
      {
        id: "b",
        setup: (ctx) => {
          received.push({ signInApi: ctx.signInApi, client: ctx.client });
        },
      },
    ]);
    expect(received[0].signInApi).toBe(SIGN_IN_API);
    expect(received[1].signInApi).toBe(SIGN_IN_API);
    expect(received[0].client).toBe(client);
    expect(received[1].client).toBe(client);
  });

  test("onInit callbacks run during init in registration order, before the session loads", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const order: string[] = [];
    const { client } = makeClientWithSignIns(
      [
        {
          id: "a",
          setup: (ctx) => ({
            // The persisted token isn't visible yet, proving the callback
            // runs before the session loads.
            onInit: () => order.push(`a:${ctx.client.getAccessToken()}`),
          }),
        },
        { id: "b", setup: () => {} },
        { id: "c", setup: () => ({ onInit: () => order.push("c") }) },
      ],
      storage,
    );
    expect(order).toEqual([]);
    await client.init();
    expect(order).toEqual(["a:null", "c"]);
    expect(client.getAccessToken()).toBe("access-1");
  });

  test("a second init after dispose does not re-run onInit callbacks", async () => {
    const onInit = vi.fn();
    const { client } = makeClientWithSignIns([
      { id: "probe", setup: () => ({ onInit }) },
    ]);
    await client.init();
    client.dispose();
    await client.init();
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  test("a withSignInPending call in onInit holds loading past the session load", async () => {
    // What every ambient sign-in does: onInit starts a sign-in whose network
    // call has not finished by the time init finishes loading the session.
    // Without the withSignInPending wrapper the client would report signed out
    // until the call finished, sending the user to a sign-in screen while they
    // are signing in.
    const signIn = Promise.withResolvers<void>();
    // onInit returns nothing, so the promise it starts is saved here for the
    // test to await.
    const pending: Promise<void>[] = [];
    const { client } = makeClientWithSignIns([
      {
        id: "probe",
        setup: (ctx) => ({
          onInit: () => {
            pending.push(
              ctx.client.withSignInPending(async () => {
                await ctx.signInApi.mutation(SIGN_IN_REF, {});
                await ctx.client.setSession(bundle(1));
              }),
            );
          },
        }),
      },
    ]);
    SIGN_IN_MUTATION.mockReturnValueOnce(signIn.promise);

    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);

    signIn.resolve();
    await Promise.all(pending);
    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
      sessionId: UNREADABLE_SESSION_ID,
    });
  });

  test("a throwing onInit callback is logged and doesn't block the rest", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const order: string[] = [];
    const { client } = makeClientWithSignIns(
      [
        {
          id: "broken",
          setup: () => ({
            onInit: () => {
              throw new Error("boom");
            },
          }),
        },
        { id: "ok", setup: () => ({ onInit: () => order.push("ok") }) },
      ],
      storage,
    );

    await client.init();
    expect(order).toEqual(["ok"]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toContain('"broken"');
    expect(client.getSnapshot()).toMatchObject({
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
      sessionId: UNREADABLE_SESSION_ID,
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
    const { client } = makeSsrClient({}, storage, {
      initialAccessToken: "access-ssr",
    });
    await client.init();

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
      sessionId: UNREADABLE_SESSION_ID,
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

/**
 * An access token of the given session, readable like a real one: the client
 * reads the session id from the token's `sub` claim. `serial` tells apart two
 * tokens of one session.
 */
function accessTokenOf(sessionId: string, serial = 0): string {
  const payload = btoa(JSON.stringify({ sub: sessionId, serial }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `header.${payload}.signature`;
}

/** A session bundle of the given session. */
function bundleOf(sessionId: string, serial = 0): TokenBundle {
  return {
    accessToken: accessTokenOf(sessionId, serial),
    refreshToken: `refresh-${sessionId}-${serial}`,
    refreshTokenExpiresAt: 0,
    userId: `user-of-${sessionId}`,
  };
}

describe("AuthClient session id", () => {
  test("follows the stored token", async () => {
    const { client } = makeClient();
    await client.init();
    expect(client.getSnapshot().sessionId).toBeNull();

    await client.setSession(bundleOf("session-a"));
    expect(client.getSnapshot().sessionId).toBe("session-a");

    await client.setSession(bundleOf("session-b"));
    expect(client.getSnapshot().sessionId).toBe("session-b");

    await client.signOut();
    expect(client.getSnapshot().sessionId).toBeNull();
  });

  test("stays the same across a refresh", async () => {
    const { client } = makeClient({
      refreshSession: async () => ({
        kind: "rotated",
        tokens: bundleOf("session-a", 1),
      }),
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });

    expect(token).toBe(accessTokenOf("session-a", 1));
    expect(client.getSnapshot().sessionId).toBe("session-a");
  });

  test("is one constant for every token that cannot be read", async () => {
    const { client } = makeClient();
    await client.init();

    for (const accessToken of ["opaque", "a.b.c", "a.e30.c", ""]) {
      await client.setSession({ ...bundle(1), accessToken });
      expect(client.getSnapshot().sessionId).toBe(UNREADABLE_SESSION_ID);
    }
  });

  test("follows a session that another tab stored", async () => {
    const listeners: Array<(event: StorageEvent) => void> = [];
    const storage = new InMemoryStorage();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.push(l),
      removeEventListener: () => {},
    };
    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundleOf("session-a"));

    listeners.forEach((l) =>
      l({
        storageArea: storage,
        key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
        newValue: accessTokenOf("session-b"),
      } as unknown as StorageEvent),
    );

    expect(client.getSnapshot().sessionId).toBe("session-b");
    restoreWindow();
  });
});

describe("AuthClient.setSession and a refresh under way", () => {
  afterEach(restoreWindow);

  for (const refreshResult of ["rotated", "noSession"] as const) {
    test(`stores the new session after a refresh that resolves to ${refreshResult}`, async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const { client, storage } = makeClient({
        refreshSession: async () => {
          await promise;
          return refreshResult === "rotated"
            ? { kind: "rotated", tokens: bundleOf("session-a", 1) }
            : { kind: "noSession" };
        },
      });
      await client.init();
      await client.setSession(bundleOf("session-a"));

      // The refresh of the old session holds the mutex when the new session
      // arrives.
      const refreshed = client.fetchAccessToken({ forceRefreshToken: true });
      const adopted = client.setSession(bundleOf("session-b"));
      resolve();
      await Promise.all([refreshed, adopted]);

      expect(client.getSnapshot().sessionId).toBe("session-b");
      expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
        "refresh-session-b-0",
      );
    });
  }

  test("a refresh that waited behind setSession does not rotate the new session", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const refreshSession = vi.fn(async (): Promise<RefreshResult> => {
      await promise;
      return { kind: "rotated", tokens: bundleOf("session-a", 1) };
    });
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundleOf("session-a"));

    // A refresh holds the mutex. The new session and a second refresh queue
    // behind it, in that order.
    const first = client.fetchAccessToken({ forceRefreshToken: true });
    const adopted = client.setSession(bundleOf("session-b"));
    const second = client.fetchAccessToken({ forceRefreshToken: true });
    resolve();
    await Promise.all([first, adopted]);

    expect(await second).toBe(accessTokenOf("session-b"));
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });
});

describe("AuthClient.switchSession", () => {
  afterEach(restoreWindow);

  /** How a sign-in result carries its session. */
  type SwitchResult =
    | { status: "complete"; tokens: TokenBundle | SlimTokenBundle }
    | { status: "error" };
  const sessionOf = (result: SwitchResult) =>
    result.status === "complete" ? result.tokens : null;

  test("adopts the session of the result", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));

    const outcome = await client.switchSession<SwitchResult>(
      async () => ({ status: "complete", tokens: bundleOf("session-b") }),
      sessionOf,
    );

    expect(outcome).toEqual({
      kind: "ran",
      result: { status: "complete", tokens: bundleOf("session-b") },
    });
    expect(client.getSnapshot().sessionId).toBe("session-b");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-b-0",
    );
  });

  test("adopts nothing from a result without a session", async () => {
    const { client } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));

    const outcome = await client.switchSession<SwitchResult>(
      async () => ({ status: "error" }),
      sessionOf,
    );

    expect(outcome).toEqual({ kind: "ran", result: { status: "error" } });
    expect(client.getSnapshot().sessionId).toBe("session-a");
  });

  test("keeps the session when the call throws", async () => {
    const { client } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));

    await expect(
      client.switchSession<SwitchResult>(async () => {
        throw new Error("offline");
      }, sessionOf),
    ).rejects.toThrow("offline");

    expect(client.getSnapshot().sessionId).toBe("session-a");
  });

  test("of two overlapping switches, the second sends nothing", async () => {
    const { client } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();
    const secondRun = vi.fn(async (): Promise<SwitchResult> => ({
      status: "complete",
      tokens: bundleOf("session-c"),
    }));

    // Two tabs (here: two calls) leave the same session at the same time.
    const first = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    const second = client.switchSession<SwitchResult>(secondRun, sessionOf);
    resolve();

    expect((await first).kind).toBe("ran");
    expect(await second).toEqual({ kind: "sessionChanged" });
    expect(secondRun).not.toHaveBeenCalled();
    expect(client.getSnapshot().sessionId).toBe("session-b");
  });

  test("sends nothing when another tab already switched", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundleOf("session-a"));
    // Another tab stored its new session, and this tab has not heard yet.
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, accessTokenOf("session-b"));
    const run = vi.fn(async (): Promise<SwitchResult> => ({ status: "error" }));

    expect(await client.switchSession(run, sessionOf)).toEqual({
      kind: "sessionChanged",
    });
    expect(run).not.toHaveBeenCalled();
  });

  test("does not adopt its session over a sign-in that completed meanwhile", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // A sign-in does not wait for the switch.
    await client.setSession(bundleOf("session-c"));
    resolve();

    expect(await switched).toEqual({ kind: "sessionChanged" });
    expect(client.getSnapshot().sessionId).toBe("session-c");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-c-0",
    );
  });

  test("reports sessionChanged for a result that changes nothing once a sign-in completed meanwhile", async () => {
    const { client } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "error" };
    }, sessionOf);
    await client.setSession(bundleOf("session-c"));
    resolve();

    expect(await switched).toEqual({ kind: "sessionChanged" });
    expect(client.getSnapshot().sessionId).toBe("session-c");
  });

  test("does not adopt its session over a session that another tab stored meanwhile", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // Another tab signed in and stored its session. This tab has not received
    // the storage event yet, so its own state still says session-a.
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, accessTokenOf("session-c"));
    storage.setItem(
      `${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`,
      "refresh-session-c-0",
    );
    expect(client.getSnapshot().sessionId).toBe("session-a");
    resolve();

    expect(await switched).toEqual({ kind: "sessionChanged" });
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-c-0",
    );
  });

  test("a held refresh result does not sign out a sign-in that completed meanwhile", async () => {
    const { client, storage } = makeClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // A refresh of session-a finds no session, and its result is held.
    await client.fetchAccessToken({ forceRefreshToken: true });
    // Then a sign-in completes.
    await client.setSession(bundleOf("session-c"));
    resolve();

    expect(await switched).toEqual({ kind: "sessionChanged" });
    expect(client.getSnapshot().sessionId).toBe("session-c");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-c-0",
    );
  });

  test("does not adopt its session if storage was cleared meanwhile", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // Simulates another tab clearing storage without a cross-tab switch lock.
    storage.removeItem(`${JWT_STORAGE_KEY}_${SUFFIX}`);
    storage.removeItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`);
    resolve();

    expect(await switched).toEqual({ kind: "sessionChanged" });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("signOut during an in-flight SPA switch waits and revokes the new session", async () => {
    const revokedTokens: string[] = [];
    const { client } = makeClient({
      signOut: async (refreshToken) => {
        revokedTokens.push(refreshToken);
      },
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      started.resolve();
      await release.promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    await started.promise;

    const signedOut = client.signOut();
    await Promise.resolve();
    expect(revokedTokens).toEqual([]);

    release.resolve();
    expect((await switched).kind).toBe("ran");
    await signedOut;

    expect(revokedTokens).toEqual(["refresh-session-b-0"]);
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      sessionId: null,
    });
  });

  test("signOutIfSession skips when another session already replaced the observed one", async () => {
    const signOut = vi.fn(async () => {});
    const { client } = makeClient({ signOut });
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      started.resolve();
      await release.promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    await started.promise;

    // A stale revocation signal for session-a queues behind the switch.
    const staleSignOut = client.signOutIfSession("session-a");
    release.resolve();
    await Promise.all([switched, staleSignOut]);

    expect(signOut).not.toHaveBeenCalled();
    expect(client.getSnapshot().sessionId).toBe("session-b");
  });

  test("SPA signOutIfSession revokes only the expected session and preserves a sign-in that completes during revocation", async () => {
    const revokedTokens: string[] = [];
    const revocationStarted = Promise.withResolvers<void>();
    const releaseRevocation = Promise.withResolvers<void>();
    const { client, storage } = makeClient({
      signOut: async (refreshToken) => {
        revokedTokens.push(refreshToken);
        revocationStarted.resolve();
        await releaseRevocation.promise;
      },
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));

    const watcherSignOut = client.signOutIfSession("session-a");
    await revocationStarted.promise;

    // An ordinary sign-in installs session-b while session-a's revocation call
    // is still in flight.
    await client.setSession(bundleOf("session-b"));
    releaseRevocation.resolve();
    await watcherSignOut;

    expect(revokedTokens).toEqual(["refresh-session-a-0"]);
    expect(client.getSnapshot().sessionId).toBe("session-b");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-b-0",
    );
  });

  test("a switch result returning 'signOut' clears local tokens immediately", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));

    const outcome = await client.switchSession<SwitchResult>(
      async () => ({ status: "error" }),
      () => "signOut",
    );

    expect(outcome).toEqual({ kind: "ran", result: { status: "error" } });
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      sessionId: null,
    });
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("a switch result returning 'signOut' under SSR clears cookies and tokens", async () => {
    const signOut = vi.fn(async () => {});
    const { client, storage } = makeSsrClient({ signOut });
    await client.init();
    await client.setSession({
      accessToken: accessTokenOf("session-a"),
      userId: "user-of-session-a",
    });

    const outcome = await client.switchSession<SwitchResult>(
      async () => ({ status: "error" }),
      () => "signOut",
    );

    expect(outcome).toEqual({ kind: "ran", result: { status: "error" } });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      sessionId: null,
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("a switch result returning 'signOut' does not clear a newer session", async () => {
    const { client } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(
      async () => {
        await promise;
        return { status: "error" };
      },
      () => "signOut",
    );
    await client.setSession(bundleOf("session-c"));
    resolve();

    expect(await switched).toEqual({ kind: "sessionChanged" });
    expect(client.getSnapshot().sessionId).toBe("session-c");
  });

  test("a second switch runs once the first ended without a new session", async () => {
    const { client } = makeClient();
    await client.init();
    await client.setSession(bundleOf("session-a"));

    const first = client.switchSession<SwitchResult>(
      async () => ({ status: "error" }),
      sessionOf,
    );
    const second = client.switchSession<SwitchResult>(
      async () => ({ status: "complete", tokens: bundleOf("session-b") }),
      sessionOf,
    );

    expect((await first).kind).toBe("ran");
    expect((await second).kind).toBe("ran");
    expect(client.getSnapshot().sessionId).toBe("session-b");
  });

  test("in a SPA, a refresh can complete while the call is under way", async () => {
    const { client } = makeClient({
      refreshSession: async () => ({
        kind: "rotated",
        tokens: bundleOf("session-a", 1),
      }),
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // The websocket asks for a fresh token while the call is under way. This
    // must not wait for the switch, or the call it carries would never end.
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
      accessTokenOf("session-a", 1),
    );
    resolve();
    await switched;

    expect(client.getSnapshot().sessionId).toBe("session-b");
  });

  test("a refresh that crosses the switch and finds no session does not sign the client out", async () => {
    const { client } = makeClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();
    const snapshots: boolean[] = [];
    client.subscribe(() =>
      snapshots.push(client.getSnapshot().isAuthenticated),
    );

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // The refresh reached the backend long after the switch committed there.
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
      accessTokenOf("session-a"),
    );
    resolve();
    await switched;

    expect(client.getSnapshot().sessionId).toBe("session-b");
    expect(snapshots).not.toContain(false);
  });

  test("a refresh in another tab that finds no session does not undo the switch", async () => {
    // Two tabs of one browser: two clients on the same storage.
    const storage = new InMemoryStorage();
    const { client: switchingTab } = makeClient({}, storage);
    const { client: otherTab } = makeClient(
      { refreshSession: async () => ({ kind: "noSession" }) },
      storage,
    );
    await switchingTab.init();
    await switchingTab.setSession(bundleOf("session-a"));
    await otherTab.init();
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = switchingTab.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "complete", tokens: bundleOf("session-b") };
    }, sessionOf);
    // The other tab refreshes session-a long after the switch committed on
    // the backend, and finds no session.
    await otherTab.fetchAccessToken({ forceRefreshToken: true });
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-a-0",
    );
    resolve();

    expect((await switched).kind).toBe("ran");
    expect(switchingTab.getSnapshot().sessionId).toBe("session-b");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-session-b-0",
    );
  });

  test("a refresh in another tab that finds no session signs out once no switch is under way", async () => {
    const storage = new InMemoryStorage();
    const { client: switchingTab } = makeClient({}, storage);
    const { client: otherTab } = makeClient(
      { refreshSession: async () => ({ kind: "noSession" }) },
      storage,
    );
    await switchingTab.init();
    await switchingTab.setSession(bundleOf("session-a"));
    await otherTab.init();
    // A switch that is refused, so it adopts nothing.
    await switchingTab.switchSession<SwitchResult>(
      async () => ({ status: "error" }),
      sessionOf,
    );

    expect(
      await otherTab.fetchAccessToken({ forceRefreshToken: true }),
    ).toBeNull();
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("a held refresh result signs the client out when the switch adopts nothing", async () => {
    const { client, storage } = makeClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.init();
    await client.setSession(bundleOf("session-a"));
    const { promise, resolve } = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      await promise;
      return { status: "error" };
    }, sessionOf);
    await client.fetchAccessToken({ forceRefreshToken: true });
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    resolve();
    await switched;

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      sessionId: null,
    });
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("under SSR, holds the refresh mutex across the call and adopts the session", async () => {
    const refreshSession = vi.fn(async () => ({
      accessToken: accessTokenOf("session-a", 1),
      userId: "user-of-session-a",
    }));
    const { client } = makeSsrClient({ refreshSession });
    await client.init();
    await client.setSession({
      accessToken: accessTokenOf("session-a"),
      userId: "user-of-session-a",
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const switched = client.switchSession<SwitchResult>(async () => {
      started.resolve();
      await promise;
      return {
        status: "complete",
        tokens: {
          accessToken: accessTokenOf("session-b"),
          userId: "user-of-session-b",
        },
      };
    }, sessionOf);
    await started.promise;
    // A refresh of this browser waits: the sign-in proxy is about to write
    // the session cookie, and a refresh under way would write it too.
    const refreshed = client.fetchAccessToken({ forceRefreshToken: true });
    await Promise.resolve();
    expect(refreshSession).not.toHaveBeenCalled();
    resolve();

    // The call resolves: storing the session does not wait for the mutex
    // that the call itself holds.
    expect((await switched).kind).toBe("ran");
    // The refresh that waited sees the new session, and does not rotate it.
    expect(await refreshed).toBe(accessTokenOf("session-b"));
    expect(refreshSession).not.toHaveBeenCalled();
    expect(client.getSnapshot().sessionId).toBe("session-b");
  });

  test("under SSR, overlapping two-tab sign-in and switch keep cookie and client tokens on the same session", async () => {
    // Shared storage and shared browser cookie jar across two tabs.
    const storage = new InMemoryStorage();
    let cookieSession: string | null = "session-a";
    const { client: tab1 } = makeSsrClient({}, storage);
    const { client: tab2 } = makeSsrClient({}, storage);
    await tab1.init();
    await tab1.setSession({
      accessToken: accessTokenOf("session-a"),
      userId: "user-of-session-a",
    });
    await tab2.init();

    // Case 1: tab1 starts a switch first; tab2 starts an ordinary SSR sign-in
    // while tab1's request is in flight.
    const switchStarted = Promise.withResolvers<void>();
    const releaseSwitch = Promise.withResolvers<void>();
    const signInStarted = vi.fn();

    const switched = tab1.switchSession<SwitchResult>(async () => {
      switchStarted.resolve();
      await releaseSwitch.promise;
      cookieSession = "session-b";
      return {
        status: "complete",
        tokens: {
          accessToken: accessTokenOf("session-b"),
          userId: "user-of-session-b",
        },
      };
    }, sessionOf);
    await switchStarted.promise;

    const signedIn = (async () => {
      const result = await tab2.runSsrSignIn(async () => {
        signInStarted();
        cookieSession = "session-c";
        return {
          status: "complete" as const,
          tokens: {
            accessToken: accessTokenOf("session-c"),
            userId: "user-of-session-c",
          },
        };
      });
      // Mirrors what every sign-in hook does after signInApi returns.
      await tab2.setSession(result.tokens);
      return result;
    })();

    await Promise.resolve();
    expect(signInStarted).not.toHaveBeenCalled();

    releaseSwitch.resolve();
    const [switchOutcome] = await Promise.all([switched, signedIn]);

    expect(switchOutcome.kind).toBe("ran");
    expect(cookieSession).toBe("session-c");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(
      accessTokenOf("session-c"),
    );

    // Case 2: tab2 starts an ordinary SSR sign-in first; tab1 tries to switch
    // from session-c while tab2's sign-in to session-d is in flight.
    await tab1.setSession({
      accessToken: accessTokenOf("session-c"),
      userId: "user-of-session-c",
    });
    const signIn2Started = Promise.withResolvers<void>();
    const releaseSignIn2 = Promise.withResolvers<void>();
    const switch2Run = vi.fn(async (): Promise<SwitchResult> => {
      cookieSession = "session-e";
      return {
        status: "complete",
        tokens: {
          accessToken: accessTokenOf("session-e"),
          userId: "user-of-session-e",
        },
      };
    });

    const signedIn2 = (async () => {
      const result = await tab2.runSsrSignIn(async () => {
        signIn2Started.resolve();
        await releaseSignIn2.promise;
        cookieSession = "session-d";
        return {
          status: "complete" as const,
          tokens: {
            accessToken: accessTokenOf("session-d"),
            userId: "user-of-session-d",
          },
        };
      });
      await tab2.setSession(result.tokens);
      return result;
    })();
    await signIn2Started.promise;

    const switched2 = tab1.switchSession(switch2Run, sessionOf);
    releaseSignIn2.resolve();

    expect(await switched2).toEqual({ kind: "sessionChanged" });
    await signedIn2;
    expect(switch2Run).not.toHaveBeenCalled();
    expect(cookieSession).toBe("session-d");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(
      accessTokenOf("session-d"),
    );
  });

  test("under SSR, signOut during an in-flight switch waits, revokes the new cookie, and cannot be undone by a late switch", async () => {
    const storage = new InMemoryStorage();
    let cookieSession: string | null = "session-a";
    const revokedCookies: Array<string | null> = [];
    const { client: tab1 } = makeSsrClient(
      {
        signOut: async () => {
          revokedCookies.push(cookieSession);
          cookieSession = null;
        },
      },
      storage,
    );
    const { client: tab2 } = makeSsrClient(
      {
        signOut: async () => {
          revokedCookies.push(cookieSession);
          cookieSession = null;
        },
      },
      storage,
    );
    await tab1.init();
    await tab1.setSession({
      accessToken: accessTokenOf("session-a"),
      userId: "user-of-session-a",
    });
    await tab2.init();

    // Tab 1 starts a switch (e.g. switching accounts); tab 2 calls signOut.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const switched = tab1.switchSession<SwitchResult>(async () => {
      started.resolve();
      await release.promise;
      cookieSession = "session-b";
      return {
        status: "complete",
        tokens: {
          accessToken: accessTokenOf("session-b"),
          userId: "user-of-session-b",
        },
      };
    }, sessionOf);
    await started.promise;

    const signedOut = tab2.signOut();
    await Promise.resolve();
    expect(revokedCookies).toEqual([]);

    release.resolve();
    await Promise.all([switched, signedOut]);

    expect(revokedCookies).toEqual(["session-b"]);
    expect(cookieSession).toBeNull();
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();

    // Reverse order: signOut starts first, then switch starts while signOut
    // is in flight. The switch never runs and never reinstalls cookies.
    cookieSession = "session-c";
    await tab1.setSession({
      accessToken: accessTokenOf("session-c"),
      userId: "user-of-session-c",
    });
    const signOutStarted = Promise.withResolvers<void>();
    const releaseSignOut = Promise.withResolvers<void>();
    const { client: tab3 } = makeSsrClient(
      {
        signOut: async () => {
          signOutStarted.resolve();
          await releaseSignOut.promise;
          revokedCookies.push(cookieSession);
          cookieSession = null;
        },
      },
      storage,
    );
    await tab3.init();

    const signOut2 = tab3.signOut();
    await signOutStarted.promise;
    const lateSwitchRun = vi.fn(async (): Promise<SwitchResult> => {
      cookieSession = "session-d";
      return {
        status: "complete",
        tokens: {
          accessToken: accessTokenOf("session-d"),
          userId: "user-of-session-d",
        },
      };
    });
    const lateSwitch = tab1.switchSession(lateSwitchRun, sessionOf);
    releaseSignOut.resolve();

    expect(await lateSwitch).toEqual({ kind: "sessionChanged" });
    await signOut2;
    expect(lateSwitchRun).not.toHaveBeenCalled();
    expect(cookieSession).toBeNull();
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("under SSR, a remount between a sign-in's adoption and its trailing setSession keeps that call a no-op", async () => {
    const { client, storage } = makeSsrClient();
    await client.init();

    const result = await client.runSsrSignIn(async () => ({
      status: "complete" as const,
      tokens: {
        accessToken: accessTokenOf("session-a"),
        userId: "user-of-session-a",
      },
    }));
    // A newer session lands, then React remounts the provider.
    await client.setSession({
      accessToken: accessTokenOf("session-b"),
      userId: "user-of-session-b",
    });
    client.dispose();
    await client.init();

    await client.setSession(result.tokens);

    expect(client.getSnapshot().sessionId).toBe("session-b");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(
      accessTokenOf("session-b"),
    );
  });

  test("under SSR, an overlapping ordinary sign-in on the same client waits for switchSession so cookie and stored session stay aligned", async () => {
    let cookieSession: string | null = "session-a";
    const { client, storage } = makeSsrClient();
    await client.init();
    await client.setSession({
      accessToken: accessTokenOf("session-a"),
      userId: "user-of-session-a",
    });

    const switchStarted = Promise.withResolvers<void>();
    const releaseSwitch = Promise.withResolvers<void>();
    const signInActionStarted = vi.fn();

    // The switch uses an unwrapped proxy call while holding the session mutex.
    const switched = client.switchSession<SwitchResult>(async () => {
      switchStarted.resolve();
      await releaseSwitch.promise;
      cookieSession = "session-b";
      return {
        status: "complete",
        tokens: {
          accessToken: accessTokenOf("session-b"),
          userId: "user-of-session-b",
        },
      };
    }, sessionOf);
    await switchStarted.promise;

    // An unrelated ordinary sign-in (e.g. an action) on the exact same client
    // must still wait on `#lockKey` rather than bypassing it.
    const ordinarySignIn = (async () => {
      const result = await client.runSsrSignIn(async () => {
        signInActionStarted();
        cookieSession = "session-c";
        return {
          status: "complete" as const,
          tokens: {
            accessToken: accessTokenOf("session-c"),
            userId: "user-of-session-c",
          },
        };
      });
      await client.setSession(result.tokens);
      return result;
    })();

    await Promise.resolve();
    expect(signInActionStarted).not.toHaveBeenCalled();

    releaseSwitch.resolve();
    const [switchOutcome] = await Promise.all([switched, ordinarySignIn]);

    expect(switchOutcome.kind).toBe("ran");
    expect(signInActionStarted).toHaveBeenCalledTimes(1);
    expect(cookieSession).toBe("session-c");
    expect(client.getSnapshot().sessionId).toBe("session-c");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(
      accessTokenOf("session-c"),
    );
  });
});
