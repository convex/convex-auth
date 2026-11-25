/**
 * Property tests of how browser tabs share a session. Random sequences of
 * signing in and out, access token fetches with and without a forced refresh,
 * requests reaching the server or not, responses lost on the way back,
 * `storage` events reaching other tabs late, and time passing run against
 * `AuthClient`s in two tabs and the core component in convex-test. The tabs
 * share one storage and one lock, as tabs of one origin share `localStorage`
 * and Web Locks.
 */
import { convexTest } from "convex-test";
import fc from "fast-check";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../component/_generated/api.ts";
import schema from "../component/schema.ts";
import { STANDARD_ISSUED_REFRESH_TOKEN_LIMIT } from "../component/sessions.ts";
import * as testApp from "../component/testApp.fixture.ts";
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
const NUM_TABS = 2;
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
 * Requests from the tabs to the app's `refreshSession` and `signOut`
 * mutations, which wait until the test serves them.
 */
class Network {
  pending: {
    kind: "refresh" | "signOut";
    refreshToken: string;
    resolve: (result: never) => void;
    reject: (error: Error) => void;
  }[] = [];
  /**
   * Refreshes in a row whose rotated token never reached the client. Each one
   * leaves an issued token nobody presents, and the server revokes the session
   * once there are `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT` of them.
   */
  lostRotations = 0;
  /** Whether lost responses alone could have revoked the session. */
  excused = false;

  constructor(private t: ConvexTestApi) {}

  api(): SpaAuthApi {
    return {
      refreshSession: (refreshToken) =>
        new Promise((resolve, reject) =>
          this.pending.push({
            kind: "refresh",
            refreshToken,
            resolve: resolve as never,
            reject,
          }),
        ),
      signOut: (refreshToken) =>
        new Promise((resolve, reject) =>
          this.pending.push({
            kind: "signOut",
            refreshToken,
            resolve: resolve as never,
            reject,
          }),
        ),
    };
  }

  /**
   * Serves the `index`th pending request, modulo how many there are. The
   * request may not reach the server, or its response may not reach the tab.
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
      request.reject(networkError());
      return true;
    }
    let result: RefreshResult | null;
    if (request.kind === "refresh") {
      result = await this.t.mutation(api.public.refresh, {
        refreshToken: request.refreshToken,
        ...TTL,
      });
      if (result.kind === "rotated") {
        if (outcome === "lostResponse") {
          this.lostRotations++;
          this.excused ||=
            this.lostRotations >= STANDARD_ISSUED_REFRESH_TOKEN_LIMIT;
        } else {
          this.lostRotations = 0;
        }
      }
    } else {
      result = await this.t.mutation(api.public.signOut, {
        refreshToken: request.refreshToken,
      });
    }
    if (outcome === "lostResponse") {
      request.reject(networkError());
    } else {
      request.resolve(result as never);
    }
    return true;
  }
}

/**
 * A browser tab. Its storage writes to the storage all tabs share, and each
 * change queues a `storage` event in every other tab, as browsers do.
 */
class Tab {
  listeners = new Set<(event: StorageEvent) => void>();
  /** `storage` events this tab hasn't received yet, in order. */
  events: { key: string; newValue: string | null }[] = [];
  client: AuthClient;
  storage: TokenStorage;
  target = {
    addEventListener: (type: string, listener: (event: StorageEvent) => void) =>
      type === "storage" && this.listeners.add(listener),
    removeEventListener: (
      type: string,
      listener: (event: StorageEvent) => void,
    ) => type === "storage" && this.listeners.delete(listener),
  };

  constructor(shared: Map<string, string>, tabs: Tab[], network: Network) {
    const changed = (key: string, newValue: string | null) => {
      for (const tab of tabs) {
        if (tab !== this) tab.events.push({ key, newValue });
      }
    };
    this.storage = {
      getItem: (key) => shared.get(key) ?? null,
      setItem: (key, value) => {
        if (shared.get(key) === value) return;
        shared.set(key, value);
        changed(key, value);
      },
      removeItem: (key) => {
        if (!shared.delete(key)) return;
        changed(key, null);
      },
    };
    this.client = new AuthClient({
      mode: "spa",
      authApi: network.api(),
      storage: this.storage,
      storageNamespace: NAMESPACE,
    });
  }

  /** `init` attaches its `storage` listener to the global `window`. */
  async init() {
    const window = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      value: this.target,
      configurable: true,
      writable: true,
    });
    const initialized = this.client.init();
    if (window === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      Object.defineProperty(globalThis, "window", window);
    }
    await initialized;
  }

  /** This tab receives one `storage` event. Returns whether there was one. */
  deliver(): boolean {
    const event = this.events.shift();
    if (event === undefined) {
      return false;
    }
    for (const listener of this.listeners) {
      listener({ ...event, storageArea: this.storage } as StorageEvent);
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
  | { type: "wait"; ms: number };

const tab = fc.integer({ min: 0, max: NUM_TABS - 1 });
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

class App {
  t = convexTest(schema, modules);
  network = new Network(this.t);
  shared = new Map<string, string>();
  tabs: Tab[] = [];
  /** The session the user last signed in to, or null after a sign-out. */
  wanted: string | null = null;
  signOutsPending = 0;
  /** Calls into the clients that haven't returned. */
  outstanding = 0;
  /** Sessions the server deleted because a used refresh token came back. */
  reuseRevocations: string[] = [];

  async start() {
    for (let i = 0; i < NUM_TABS; i++) {
      this.tabs.push(new Tab(this.shared, this.tabs, this.network));
    }
    for (const tab of this.tabs) {
      await tab.init();
    }
  }

  private track(promise: Promise<unknown>) {
    this.outstanding++;
    void promise
      .catch(() => {})
      .finally(() => {
        this.outstanding--;
      });
  }

  async apply(op: Op) {
    switch (op.type) {
      case "signIn": {
        // A sign-in started during a sign-out may finish before it, and the
        // user wanted neither outcome over the other.
        if (this.signOutsPending > 0) break;
        const bundle = await this.t.mutation(
          api.public._internal_dangerous_signIn,
          {
            claims: { method: "usernamePassword", profile: {} },
            componentPath: "authPassword",
            userId: "user1",
            ...TTL,
          },
        );
        this.wanted = sessionOf(bundle.accessToken);
        this.network.lostRotations = 0;
        this.network.excused = false;
        await this.tabs[op.tab].client.setSession(bundle);
        break;
      }
      case "signOut": {
        this.wanted = null;
        this.signOutsPending++;
        this.track(
          this.tabs[op.tab].client.signOut().finally(() => {
            this.signOutsPending--;
          }),
        );
        break;
      }
      case "fetch":
        this.track(
          this.tabs[op.tab].client.fetchAccessToken({
            forceRefreshToken: op.force,
          }),
        );
        break;
      case "serve":
        await this.network.serve(op.index, op.outcome);
        break;
      case "deliver":
        this.tabs[op.tab].deliver();
        break;
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
      while (await this.network.serve(0, "ok")) {
        progressed = true;
        await vi.advanceTimersByTimeAsync(0);
      }
      if (!progressed && this.outstanding === 0) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1000);
    }
    throw new Error("the tabs didn't settle");
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

  async checkSettled() {
    this.checkTabsMatchStorage();
    // Each tab refreshes once more, as when its access token expires.
    for (const tab of this.tabs) {
      this.track(tab.client.fetchAccessToken({ forceRefreshToken: true }));
      await this.settle();
    }
    const sessions = await this.t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect()).map((s) => s._id as string),
    );
    this.checkTabsMatchStorage();
    const stored = this.shared.get(JWT_KEY) ?? null;
    if (this.wanted === null) {
      expect(stored, "signed out").toBe(null);
      expect(this.shared.get(REFRESH_KEY) ?? null).toBe(null);
      return;
    }
    if (this.network.excused) {
      return;
    }
    expect(
      this.reuseRevocations,
      "the server saw a used refresh token",
    ).toEqual([]);
    expect(sessions, "the session is alive").toContain(this.wanted);
    expect(sessionOf(stored), "the tabs use the session").toBe(this.wanted);
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function runOps(ops: Op[]) {
  app = new App();
  await app.start();
  // Most bugs need a session, so every run starts signed in.
  for (const op of [{ type: "signIn", tab: 0 } as Op, ...ops]) {
    await app.apply(op);
  }
  await app.settle();
  await app.checkSettled();
}

test("tabs keep the session they signed in to", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(op, { minLength: 1, maxLength: 40, size: "max" }),
      runOps,
    ),
    { numRuns: 300 },
  );
}, 300_000);

// Counterexamples the property test found, replayed on every run. Each run
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
