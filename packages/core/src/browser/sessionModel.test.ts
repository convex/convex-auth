/**
 * Property tests of how an app's pages share a session. Random sequences of
 * signing in and out, access token fetches with and without a forced refresh,
 * requests reaching the server or not, responses lost on the way back,
 * `storage` events reaching other tabs late, page reloads, and time passing
 * run against `AuthClient`s and the core component in convex-test.
 *
 * Browser runs have two tabs sharing one `localStorage` and one lock, as tabs
 * of one origin share `localStorage` and Web Locks. React Native runs have one
 * app whose storage, like `expo-secure-store`, answers each call later, in
 * order, and fires no `storage` events.
 */
import { convexTest } from "convex-test";
import fc from "fast-check";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../component/_generated/api.ts";
import schema from "../component/schema.ts";
import { STANDARD_ISSUED_REFRESH_TOKEN_LIMIT } from "../component/sessions.ts";
import * as testApp from "../component/testApp.fixture.ts";
import { sha256Hex } from "../lib/crypto.ts";
import type { RefreshResult } from "../lib/types.ts";
import { resolveTtlConfig } from "../lib/ttl.ts";
import { AuthClient, type SpaAuthApi } from "./sessionManager.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from "./storage.ts";

// As in component/core.test.ts, the fixture is injected as `testApp.ts`.
const modules = {
  ...import.meta.glob([
    "../component/**/*.ts",
    "!../component/**/*.fixture.ts",
  ]),
  "../component/testApp.ts": async () => testApp,
};

const TTL = resolveTtlConfig({});
const NAMESPACE = "https://happy-animal-123.convex.cloud";
const MAX_TABS = 2;
const KEYS = new NamespacedStorage(new InMemoryStorage(), NAMESPACE);
const JWT_KEY = KEYS.key(JWT_STORAGE_KEY);
const REFRESH_KEY = KEYS.key(REFRESH_TOKEN_STORAGE_KEY);

type ConvexTestApi = ReturnType<typeof convexTest>;

function networkError() {
  return new TypeError("Failed to fetch");
}

/** The session id an access token is for. */
function sessionOf(accessToken: string | null): string | null {
  return accessToken === null ? null : (decodeJwt(accessToken).sub ?? null);
}

/**
 * `navigator.locks` for one origin. As in browsers, a lock is released when
 * the page holding it is unloaded, even though its callback never returns.
 * A holder's page is the page of the first request or storage call it makes.
 */
class Locks {
  private waiting = new Map<string, Holder[]>();
  private holders = new Map<string, Holder>();

  request<T>(key: string, callback: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const holder: Holder = {
        run: () => callback().then(resolve, reject),
        page: null,
      };
      this.waiting.set(key, [...(this.waiting.get(key) ?? []), holder]);
      this.grant(key);
    });
  }

  private grant(key: string) {
    if (this.holders.has(key)) return;
    const holder = this.waiting.get(key)?.shift();
    if (holder === undefined) return;
    this.holders.set(key, holder);
    void holder.run().finally(() => this.release(key, holder));
  }

  private release(key: string, holder: Holder) {
    if (this.holders.get(key) !== holder) return;
    this.holders.delete(key);
    this.grant(key);
  }

  /** Records the page of a holder that hasn't made a call yet. */
  claim(live: () => boolean) {
    for (const holder of this.holders.values()) holder.page ??= live;
  }

  /** Whether any page holds a lock. */
  busy(): boolean {
    return this.holders.size > 0;
  }

  /** Releases the locks of pages that were unloaded. */
  releaseUnloaded() {
    for (const [key, holder] of this.holders) {
      if (holder.page !== null && !holder.page()) this.release(key, holder);
    }
  }
}

type Holder = { run: () => Promise<void>; page: (() => boolean) | null };

/**
 * Requests from the pages to the app's `refreshSession` and `signOut`
 * mutations, which wait until the test serves them.
 */
class Network {
  pending: {
    kind: "refresh" | "signOut";
    refreshToken: string;
    /** Whether the page that sent the request is still loaded. */
    live: () => boolean;
    resolve: (result: never) => void;
    reject: (error: Error) => void;
  }[] = [];
  /**
   * Refreshes in a row whose rotated token never reached the client. Each one
   * leaves an issued token nobody presents, and the server revokes the session
   * once there are `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT` of them.
   */
  lostRotations = new Map<string, number>();

  /** Whether lost responses alone could have revoked `session`. */
  excused(session: string | null): boolean {
    return (
      session !== null &&
      (this.lostRotations.get(session) ?? 0) >=
        STANDARD_ISSUED_REFRESH_TOKEN_LIMIT
    );
  }

  constructor(
    private t: ConvexTestApi,
    private locks: Locks,
  ) {}

  api(live: () => boolean): SpaAuthApi {
    const send =
      (kind: "refresh" | "signOut") =>
      (refreshToken: string): Promise<never> => {
        // Only a refresh holds the lock.
        if (kind === "refresh") this.locks.claim(live);
        // A lock request queued before a reload runs its callback after it,
        // but the unloaded page sends nothing.
        if (!live()) {
          this.locks.releaseUnloaded();
          return new Promise(() => {});
        }
        return new Promise((resolve, reject) =>
          this.pending.push({ kind, refreshToken, live, resolve, reject }),
        );
      };
    return { refreshSession: send("refresh"), signOut: send("signOut") };
  }

  /**
   * An unloaded page's requests either reached the server already or never
   * will: the browser cancels them.
   */
  async unload(sent: boolean) {
    for (const request of [...this.pending]) {
      if (request.live()) continue;
      const index = this.pending.indexOf(request);
      if (sent) {
        await this.serve(index, "lostResponse");
      } else {
        this.pending.splice(index, 1);
      }
    }
  }

  /**
   * Serves the `index`th pending request, modulo how many there are. The
   * request may not reach the server, or its response may not reach the page.
   * A page that was reloaded gets no response.
   */
  async serve(
    index: number,
    outcome: "ok" | "lostRequest" | "lostResponse",
  ): Promise<boolean> {
    if (this.pending.length === 0) {
      return false;
    }
    const [request] = this.pending.splice(index % this.pending.length, 1);
    if (outcome === "lostRequest") {
      if (request.live()) request.reject(networkError());
      return true;
    }
    const delivered = outcome === "ok" && request.live();
    let result: RefreshResult | null;
    if (request.kind === "refresh") {
      result = await this.t.mutation(api.public.refresh, {
        refreshToken: request.refreshToken,
        ...TTL,
      });
      if (result.kind === "rotated") {
        const session = sessionOf(result.tokens.accessToken)!;
        const lost = this.lostRotations.get(session) ?? 0;
        // Once excused, a session stays excused: the server may revoke it at
        // any later refresh.
        if (!this.excused(session)) {
          this.lostRotations.set(session, delivered ? 0 : lost + 1);
        }
      }
    } else {
      result = await this.t.mutation(api.public.signOut, {
        refreshToken: request.refreshToken,
      });
    }
    if (delivered) {
      request.resolve(result as never);
    } else if (request.live()) {
      request.reject(networkError());
    }
    return true;
  }
}

/**
 * Storage calls that answer later, in the order they were made, as
 * `expo-secure-store` does. Each call takes effect when it answers.
 */
class AsyncStorageQueue {
  pending: {
    run: () => unknown;
    live: () => boolean;
    resolve: (value: never) => void;
  }[] = [];

  constructor(private locks: Locks) {}

  call<T>(live: () => boolean, run: () => T): Promise<T> {
    // React Native runs have one app, so any call is the lock holder's.
    this.locks.claim(live);
    if (!live()) {
      this.locks.releaseUnloaded();
      return new Promise(() => {});
    }
    return new Promise((resolve) =>
      this.pending.push({ run, live, resolve: resolve as never }),
    );
  }

  /** The oldest call takes effect. Returns whether there was one. */
  step(): boolean {
    const call = this.pending.shift();
    if (call === undefined) {
      return false;
    }
    const value = call.run();
    // A page that was reloaded doesn't see the answer, but the call happened.
    if (call.live()) call.resolve(value as never);
    return true;
  }
}

/**
 * A browser tab, or the React Native app. A reload replaces its page: the old
 * page's `AuthClient` never hears back from its requests or storage calls.
 */
class Tab {
  listeners = new Set<(event: StorageEvent) => void>();
  /** `storage` events this tab hasn't received yet, in order. */
  events: { key: string; newValue: string | null }[] = [];
  /** Counts reloads. */
  page = 0;
  /** The current page's writes of the access token, null for a removal. */
  jwtWrites: (string | null)[] = [];
  /** The key of the current page's last write. */
  lastWrite: string | null = null;
  client!: AuthClient;
  target = {
    addEventListener: (type: string, listener: (event: StorageEvent) => void) =>
      type === "storage" && this.listeners.add(listener),
    removeEventListener: (
      type: string,
      listener: (event: StorageEvent) => void,
    ) => type === "storage" && this.listeners.delete(listener),
  };

  constructor(private app: App) {
    this.load();
  }

  /** Whether the current page is still loaded, for its calls to check. */
  liveCheck(): () => boolean {
    const page = this.page;
    return () => this.page === page;
  }

  private storage(live: () => boolean): TokenStorage {
    const { shared, tabs, asyncStorage } = this.app;
    const changed = (key: string, newValue: string | null) => {
      for (const tab of tabs) {
        if (tab !== this) tab.events.push({ key, newValue });
      }
    };
    const sync = {
      getItem: (key: string) => shared.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (shared.get(key) === value) return;
        shared.set(key, value);
        changed(key, value);
      },
      removeItem: (key: string) => {
        if (!shared.delete(key)) return;
        changed(key, null);
      },
    };
    const wrote = (key: string, value: string | null) => {
      if (!live()) return;
      if (key === JWT_KEY) this.jwtWrites.push(value);
      this.lastWrite = key;
    };
    if (asyncStorage === null) {
      // A lock callback queued before a reload runs after it, but the
      // unloaded page writes nothing.
      return {
        getItem: (key) => {
          this.app.locks.claim(live);
          return sync.getItem(key);
        },
        setItem: (key, value) => {
          this.app.locks.claim(live);
          if (!live()) return this.app.locks.releaseUnloaded();
          wrote(key, value);
          sync.setItem(key, value);
        },
        removeItem: (key) => {
          this.app.locks.claim(live);
          if (!live()) return this.app.locks.releaseUnloaded();
          wrote(key, null);
          sync.removeItem(key);
        },
      };
    }
    return {
      getItem: (key) => asyncStorage.call(live, () => sync.getItem(key)),
      setItem: (key, value) => {
        wrote(key, value);
        return asyncStorage.call(live, () => sync.setItem(key, value));
      },
      removeItem: (key) => {
        wrote(key, null);
        return asyncStorage.call(live, () => sync.removeItem(key));
      },
    };
  }

  /** Loads a new page with its own `AuthClient`. */
  load() {
    this.client?.dispose();
    this.page++;
    this.jwtWrites = [];
    this.lastWrite = null;
    this.events = [];
    const live = this.liveCheck();
    this.client = new AuthClient({
      mode: "spa",
      authApi: this.app.network.api(live),
      storage: this.storage(live),
      storageNamespace: NAMESPACE,
    });
  }

  /**
   * `init` attaches its `storage` listener to the global `window`, which
   * React Native doesn't have.
   */
  init(): Promise<void> {
    const window = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      value: this.app.asyncStorage === null ? this.target : undefined,
      configurable: true,
      writable: true,
    });
    const initialized = this.client.init();
    if (window === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", window);
    }
    return initialized;
  }

  /** This tab receives one `storage` event. Returns whether there was one. */
  deliver(): boolean {
    const event = this.events.shift();
    if (event === undefined) {
      return false;
    }
    for (const listener of this.listeners) {
      listener({
        ...event,
        storageArea: this.client.storage.storage,
      } as StorageEvent);
    }
    return true;
  }
}

type Op =
  | { type: "signIn"; tab: number }
  | { type: "signOut"; tab: number }
  | { type: "fetch"; tab: number; force: boolean }
  | {
      type: "serve";
      index: number;
      outcome: "ok" | "lostRequest" | "lostResponse";
    }
  | { type: "deliver"; tab: number }
  | { type: "storage" }
  | { type: "reload"; tab: number; sent: boolean }
  | { type: "wait"; ms: number };

const tab = fc.integer({ min: 0, max: MAX_TABS - 1 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 2, arbitrary: tab.map((tab) => ({ type: "signIn", tab }) as Op) },
  { weight: 1, arbitrary: tab.map((tab) => ({ type: "signOut", tab }) as Op) },
  {
    weight: 8,
    arbitrary: fc
      .record({ tab, force: fc.constantFrom(true, true, true, false) })
      .map(({ tab, force }) => ({ type: "fetch", tab, force }) as Op),
  },
  {
    weight: 10,
    arbitrary: fc
      .record({
        index: fc.integer({ min: 0, max: 3 }),
        outcome: fc.constantFrom(
          "ok" as const,
          "ok" as const,
          "lostRequest" as const,
          "lostResponse" as const,
        ),
      })
      .map(({ index, outcome }) => ({ type: "serve", index, outcome }) as Op),
  },
  { weight: 4, arbitrary: tab.map((tab) => ({ type: "deliver", tab }) as Op) },
  { weight: 8, arbitrary: fc.constant({ type: "storage" } as Op) },
  {
    weight: 1,
    arbitrary: fc
      .record({ tab, sent: fc.boolean() })
      .map(({ tab, sent }) => ({ type: "reload", tab, sent }) as Op),
  },
  {
    weight: 3,
    arbitrary: fc
      .oneof(
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 60_000, max: 2 * 60 * 60 * 1000 }),
      )
      .map((ms) => ({ type: "wait", ms }) as Op),
  },
);

/** Calls into a page's client that haven't returned. */
type Call = {
  kind: "signIn" | "signOut" | "other";
  tab: Tab;
  live: () => boolean;
  /** The access token the call writes: a sign-in's, or null to sign out. */
  writes?: string | null;
  /** How many access token writes the page had made when the call started. */
  jwtWritesBefore: number;
  /** `App.wanted` before the call. */
  wantedBefore: string | null;
};

class App {
  t = convexTest(schema, modules);
  locks = new Locks();
  network = new Network(this.t, this.locks);
  asyncStorage: AsyncStorageQueue | null;
  shared = new Map<string, string>();
  tabs: Tab[] = [];
  /** The session the user last signed in to, or null after a sign-out. */
  wanted: string | null = null;
  calls = new Set<Call>();
  /** Sessions the server deleted because a used refresh token came back. */
  reuseRevocations: string[] = [];
  /** Whether a page was unloaded in the middle of storing its tokens. */
  torn = false;

  constructor(numTabs: number, asyncStorage: boolean) {
    this.asyncStorage = asyncStorage ? new AsyncStorageQueue(this.locks) : null;
    Object.defineProperty(navigator, "locks", {
      value: this.locks,
      configurable: true,
    });
    for (let i = 0; i < numTabs; i++) {
      this.tabs.push(new Tab(this));
    }
  }

  tab(index: number): Tab {
    return this.tabs[index % this.tabs.length];
  }

  async start() {
    for (const tab of this.tabs) {
      this.track("other", tab, () => tab.init());
    }
    await this.settle();
  }

  /** Starts a call into a page's client and tracks it until it returns. */
  private track(
    kind: Call["kind"],
    tab: Tab,
    start: () => Promise<unknown>,
    wantedBefore: string | null = this.wanted,
    writes?: string | null,
  ) {
    const call = {
      kind,
      tab,
      live: tab.liveCheck(),
      writes,
      jwtWritesBefore: tab.jwtWrites.length,
      wantedBefore,
    };
    this.calls.add(call);
    void start()
      .catch(() => {})
      .finally(() => {
        this.calls.delete(call);
      });
  }

  /** Calls from loaded pages that haven't returned. */
  liveCalls(kind?: Call["kind"]): number {
    return [...this.calls].filter(
      (call) => call.live() && (kind === undefined || call.kind === kind),
    ).length;
  }

  async apply(op: Op) {
    switch (op.type) {
      case "signIn": {
        // The user wants whichever of overlapping sign-ins and sign-outs
        // finishes last, which the test doesn't know.
        if (this.liveCalls("signIn") + this.liveCalls("signOut") > 0) break;
        const bundle = await this.t.mutation(
          api.public._internal_dangerous_signIn,
          {
            claims: { method: "usernamePassword", profile: {} },
            componentPath: "authPassword",
            userId: "user1",
            ...TTL,
          },
        );
        const wantedBefore = this.wanted;
        this.wanted = sessionOf(bundle.accessToken);
        const tab = this.tab(op.tab);
        this.track(
          "signIn",
          tab,
          () => tab.client.setSession(bundle),
          wantedBefore,
          bundle.accessToken,
        );
        break;
      }
      case "signOut": {
        if (this.liveCalls("signIn") + this.liveCalls("signOut") > 0) break;
        const wantedBefore = this.wanted;
        this.wanted = null;
        const tab = this.tab(op.tab);
        this.track(
          "signOut",
          tab,
          () => tab.client.signOut(),
          wantedBefore,
          null,
        );
        break;
      }
      case "fetch": {
        const tab = this.tab(op.tab);
        this.track("other", tab, () =>
          tab.client.fetchAccessToken({ forceRefreshToken: op.force }),
        );
        break;
      }
      case "serve":
        await this.network.serve(op.index, op.outcome);
        break;
      case "deliver":
        this.tab(op.tab).deliver();
        break;
      case "storage":
        this.asyncStorage?.step();
        break;
      case "reload": {
        const tab = this.tab(op.tab);
        for (const call of this.calls) {
          if (call.tab !== tab || !call.live()) continue;
          // A sign-in or sign-out still waiting for the lock never happened.
          if (
            call.writes !== undefined &&
            !tab.jwtWrites.slice(call.jwtWritesBefore).includes(call.writes) &&
            this.locks.busy()
          ) {
            this.wanted = call.wantedBefore;
          }
        }
        // `#storeTokens` writes the access token, then the refresh token. A
        // page unloaded between the two leaves them for different sessions.
        this.torn ||= tab.lastWrite === JWT_KEY;
        tab.load();
        this.locks.releaseUnloaded();
        await this.network.unload(op.sent);
        this.track("other", tab, () => tab.init());
        break;
      }
      case "wait":
        await vi.advanceTimersByTimeAsync(op.ms);
        break;
    }
    await vi.advanceTimersByTimeAsync(0);
  }

  /** Deliver everything and let every call return. */
  async settle() {
    for (let i = 0; i < 1000; i++) {
      let progressed = false;
      for (const tab of this.tabs) {
        while (tab.deliver()) progressed = true;
      }
      while (this.asyncStorage?.step()) {
        progressed = true;
        await vi.advanceTimersByTimeAsync(0);
      }
      while (await this.network.serve(0, "ok")) {
        progressed = true;
        await vi.advanceTimersByTimeAsync(0);
      }
      if (!progressed && this.liveCalls() === 0) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    throw new Error("the pages didn't settle");
  }

  /** Once every `storage` event arrived, the tabs show the stored session. */
  checkTabsMatchStorage() {
    const stored = this.shared.get(JWT_KEY) ?? null;
    for (const [i, tab] of this.tabs.entries()) {
      expect(tab.client.getAccessToken(), `tab ${i} matches storage`).toBe(
        stored,
      );
    }
  }

  /** The session of the stored refresh token, or null if none is stored. */
  async storedRefreshSession(): Promise<string | null> {
    const refreshToken = this.shared.get(REFRESH_KEY);
    if (refreshToken === undefined) {
      return null;
    }
    const hash = await sha256Hex(refreshToken);
    return await this.t.run(async (ctx) => {
      const row = await ctx.db
        .query("refreshTokens")
        .withIndex("by_hash", (q) => q.eq("hash", hash))
        .unique();
      return row === null ? "unknown" : (row.sessionId as string);
    });
  }

  async checkSettled() {
    this.checkTabsMatchStorage();
    const stored = this.shared.get(JWT_KEY) ?? null;
    const sessionsBefore = await this.t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect()).map((s) => s._id as string),
    );
    // A deleted session's token rows are deleted too, so its refresh token
    // reads as unknown.
    if (
      stored !== null &&
      sessionsBefore.includes(sessionOf(stored)!) &&
      !this.network.excused(this.wanted) &&
      !this.torn
    ) {
      expect(
        await this.storedRefreshSession(),
        "the stored tokens are for one session",
      ).toBe(sessionOf(stored));
    }
    // Each tab refreshes once more, as when its access token expires.
    for (const tab of this.tabs) {
      this.track("other", tab, () =>
        tab.client.fetchAccessToken({ forceRefreshToken: true }),
      );
      await this.settle();
    }
    const sessions = await this.t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect()).map((s) => s._id as string),
    );
    this.checkTabsMatchStorage();
    const refreshed = this.shared.get(JWT_KEY) ?? null;
    if (this.torn) {
      return;
    }
    if (this.wanted === null) {
      expect(refreshed, "signed out").toBe(null);
      expect(this.shared.get(REFRESH_KEY) ?? null).toBe(null);
      return;
    }
    if (this.network.excused(this.wanted)) {
      return;
    }
    expect(
      this.reuseRevocations,
      "the server saw a used refresh token",
    ).toEqual([]);
    expect(sessions, "the session is alive").toContain(this.wanted);
    expect(sessionOf(refreshed), "the tabs use the session").toBe(this.wanted);
  }
}

let app: App;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation((message: unknown) => {
    if (String(message).includes("refresh token used")) {
      app?.reuseRevocations.push(String(message));
    }
  });
});

afterEach(() => {
  delete (navigator as { locks?: unknown }).locks;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function runOps(ops: Op[], platform: "browser" | "native" = "browser") {
  app = platform === "browser" ? new App(MAX_TABS, false) : new App(1, true);
  await app.start();
  // Most bugs need a session, so every run starts signed in.
  for (const op of [{ type: "signIn", tab: 0 } as Op, ...ops]) {
    await app.apply(op);
  }
  await app.settle();
  await app.checkSettled();
}

const ops = fc.array(op, { minLength: 1, maxLength: 40, size: "max" });

test("tabs keep the session they signed in to", async () => {
  await fc.assert(
    fc.asyncProperty(ops, (ops) => runOps(ops, "browser")),
    { numRuns: 300 },
  );
}, 300_000);

test("a React Native app keeps the session it signed in to", async () => {
  await fc.assert(
    fc.asyncProperty(ops, (ops) => runOps(ops, "native")),
    { numRuns: 300 },
  );
}, 300_000);

// Counterexamples the property tests found, replayed on every run. Each run
// starts with tab 0 signed in.

test("a refresh in flight during a sign-in doesn't overwrite the new session", async () => {
  await runOps([
    { type: "fetch", tab: 0, force: true },
    { type: "signIn", tab: 0 },
  ]);
});

test("a tab doesn't refresh a session another tab signed out of", async () => {
  await runOps([
    { type: "signOut", tab: 1 },
    { type: "serve", index: 0, outcome: "lostRequest" },
    { type: "fetch", tab: 0, force: true },
    { type: "serve", index: 0, outcome: "ok" },
  ]);
});

test("a storage event arriving after a sign-out doesn't sign the tab back in", async () => {
  await runOps([
    { type: "signOut", tab: 1 },
    { type: "serve", index: 0, outcome: "ok" },
    { type: "deliver", tab: 0 },
  ]);
});

test("a tab unloaded during a sign-out stays signed out", async () => {
  await runOps([
    { type: "signOut", tab: 0 },
    { type: "reload", tab: 0, sent: false },
  ]);
});

test("a React Native app refreshing right after a sign-in keeps the session", async () => {
  await runOps([{ type: "fetch", tab: 0, force: true }], "native");
});

test("a React Native app signing in while it loads keeps the session", async () => {
  await runOps(
    [
      { type: "reload", tab: 0, sent: false },
      { type: "signIn", tab: 0 },
      { type: "storage" },
    ],
    "native",
  );
});
