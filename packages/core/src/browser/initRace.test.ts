import { describe, expect, test } from "vitest";
import type { TokenBundle } from "../lib/types.ts";
import { AuthClient } from "./sessionManager.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from "./storage.ts";

// The race fixed by 3e952bb (`erquhart/fix-init-race`), which this branch
// does not have: init() assigns the tokens it read from storage
// unconditionally, so a session set while the read is out is replaced in
// memory by the older stored value, while storage keeps the new one. These
// tests pin the behaviour of the code on this branch, which the explorer
// shows; they fail once the fix is in, and are then replaced by its tests.

const NAMESPACE = "http://127.0.0.1:3210";
const SUFFIX = "http1270013210";
const JWT = `${JWT_STORAGE_KEY}_${SUFFIX}`;
const REFRESH = `${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`;

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 0,
    userId: "user-1",
  };
}

/**
 * Storage whose reads return the value stored when they started, and answer
 * only when `release` is called: slow storage, as on React Native.
 */
function slowStorage(entries: Record<string, string> = {}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const store = new InMemoryStorage();
  for (const [key, value] of Object.entries(entries)) {
    store.setItem(key, value);
  }
  const storage: TokenStorage = {
    getItem: async (key) => {
      const value = store.getItem(key);
      await gate;
      return value;
    },
    setItem: (key, value) => store.setItem(key, value),
    removeItem: (key) => store.removeItem(key),
  };
  return { storage, store, release };
}

function newClient(storage: TokenStorage) {
  return new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" }),
      signOut: async () => {},
    },
    storage,
    storageNamespace: NAMESPACE,
  });
}

describe("the first load overwrites a setSession made during it (before 3e952bb)", () => {
  test("a sign-in during the first read ends signed out in memory, signed in in storage", async () => {
    const { storage, store, release } = slowStorage();
    const client = newClient(storage);

    const loading = client.init(); // reads both keys: null, null
    await client.setSession(bundle(1)); // memory and storage: session 1
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true });
    release(); // the reads answer with what they saw: null
    await loading;

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: false,
      token: null,
    });
    expect(store.getItem(JWT)).toBe("access-1");
    expect(store.getItem(REFRESH)).toBe("refresh-1");
  });

  test("a new session during the read is replaced in memory by the stored older one", async () => {
    const { storage, store, release } = slowStorage({
      [JWT]: "access-1",
      [REFRESH]: "refresh-1",
    });
    const client = newClient(storage);

    const loading = client.init();
    await client.setSession(bundle(2));
    release();
    await loading;

    expect(client.getSnapshot().token).toBe("access-1");
    expect(store.getItem(JWT)).toBe("access-2");
  });
});
