import { describe, expect, test, vi } from "vitest";
import { createPendingTracker, createStore, selectStore } from "./store.ts";

describe("createStore", () => {
  test("notifies the subscribers of a change, and only of a change", () => {
    const store = createStore(1);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(2);
    expect(store.get()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);

    // The same value is no change.
    store.set(2);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a listener that unsubscribes while notified does not skip others", () => {
    const store = createStore("a");
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(() => unsubscribeFirst());
    store.subscribe(second);
    store.set("b");
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("selectStore", () => {
  test("notifies the subscribers only when the selected part changes", () => {
    const store = createStore({ secret: "a", pending: false });
    const secret = selectStore(store, (value) => value.secret);
    const listener = vi.fn();
    const unsubscribe = secret.subscribe(listener);

    store.set({ secret: "a", pending: true });
    expect(listener).not.toHaveBeenCalled();
    expect(secret.get()).toBe("a");

    store.set({ secret: "b", pending: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(secret.get()).toBe("b");

    unsubscribe();
    store.set({ secret: "c", pending: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("createPendingTracker", () => {
  test("is pending until the last tracked call is done", async () => {
    const { pending, track } = createPendingTracker();
    const changes: boolean[] = [];
    pending.subscribe(() => changes.push(pending.get()));

    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = track(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    const second = track(
      () => new Promise<void>((resolve) => (finishSecond = resolve)),
    );
    expect(pending.get()).toBe(true);

    finishFirst();
    await first;
    expect(pending.get()).toBe(true);

    finishSecond();
    await second;
    expect(pending.get()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  test("resets when the work throws", async () => {
    const { pending, track } = createPendingTracker();
    await expect(
      track(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(pending.get()).toBe(false);
  });
});
