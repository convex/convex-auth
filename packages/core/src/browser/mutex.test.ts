import { afterEach, describe, expect, test, vi } from "vitest";
import { isMutexHeld, runWithMutex } from "./mutex.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isMutexHeld without the Web Locks API", () => {
  test("is true only while a callback holds that lock", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    expect(await isMutexHeld("in-process")).toBe(false);

    const running = runWithMutex("in-process", () => promise);

    expect(await isMutexHeld("in-process")).toBe(true);
    expect(await isMutexHeld("another")).toBe(false);
    resolve();
    await running;
    expect(await isMutexHeld("in-process")).toBe(false);
  });
});

describe("isMutexHeld with the Web Locks API", () => {
  /** Stub `navigator.locks.query()` to report the given held locks. */
  function stubHeldLocks(held: Array<{ name: string }> | undefined) {
    vi.stubGlobal("navigator", {
      locks: { query: async () => ({ held, pending: [] }) },
    });
  }

  test("is true when a tab holds the lock", async () => {
    stubHeldLocks([{ name: "unrelated" }, { name: "switch" }]);
    expect(await isMutexHeld("switch")).toBe(true);
  });

  test("is false when only other locks are held", async () => {
    stubHeldLocks([{ name: "unrelated" }]);
    expect(await isMutexHeld("switch")).toBe(false);
  });

  test("is false when no lock is held", async () => {
    stubHeldLocks([]);
    expect(await isMutexHeld("switch")).toBe(false);
    stubHeldLocks(undefined);
    expect(await isMutexHeld("switch")).toBe(false);
  });
});
