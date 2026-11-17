import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import { createStore } from "../browser/store.ts";
import { fromReadableStore } from "./store.ts";
import { watch } from "./testing.svelte.fixture.ts";

/** A store that counts its subscribers. */
function countedStore<T>(initial: T) {
  const store = createStore(initial);
  let subscribers = 0;
  return {
    ...store,
    subscribers: () => subscribers,
    subscribe: (listener: () => void) => {
      subscribers++;
      const unsubscribe = store.subscribe(listener);
      return () => {
        subscribers--;
        unsubscribe();
      };
    },
  };
}

describe("fromReadableStore", () => {
  it("runs an effect that reads `current` again when the store changes", () => {
    const store = countedStore(1);
    const value = fromReadableStore(store);
    const { values, stop } = watch(() => value.current);

    store.set(2);
    flushSync();
    store.set(2);
    flushSync();
    store.set(3);
    flushSync();

    expect(values).toEqual([1, 2, 3]);
    stop();
  });

  it("subscribes while an effect reads it, and unsubscribes after", () => {
    const store = countedStore("a");
    const value = fromReadableStore(store);
    expect(store.subscribers()).toBe(0);

    const first = watch(() => value.current);
    const second = watch(() => value.current);
    // One subscription, however many effects read it.
    expect(store.subscribers()).toBe(1);

    first.stop();
    second.stop();
    flushSync();
    expect(store.subscribers()).toBe(0);

    store.set("b");
    flushSync();
    expect(first.values).toEqual(["a"]);
  });

  it("reads the store outside of an effect, without subscribing", () => {
    const store = countedStore(1);
    const value = fromReadableStore(store);
    expect(value.current).toBe(1);
    store.set(2);
    expect(value.current).toBe(2);
    expect(store.subscribers()).toBe(0);
  });
});
