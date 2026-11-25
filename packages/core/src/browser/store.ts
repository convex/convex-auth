/**
 * The subscribable value that the framework-agnostic method clients use for
 * their state, like `pending`.
 *
 * The shape is the one that React's `useSyncExternalStore` takes, and Svelte's
 * `createSubscriber`, Vue's `customRef` or Solid's `from` adapt to in a few
 * lines: read the current value with `get`, and get told when it changes with
 * `subscribe`. A value is replaced, never mutated, so two reads without a
 * change in between return the same value.
 *
 * It is not Svelte's store contract: `subscribe` doesn't call the listener
 * right away, nor pass it the value, so `$store` doesn't work on it.
 *
 * @module
 */

/** A value that changes over time, and tells its subscribers when it does. */
export type ReadableStore<T> = {
  /** The current value. */
  get: () => T;
  /**
   * Call `listener` after each change of the value. Read the new value with
   * `get`. Returns the function that unsubscribes.
   */
  subscribe: (listener: () => void) => () => void;
};

/** A {@link ReadableStore} that its owner can write. */
export type WritableStore<T> = ReadableStore<T> & {
  /** Replace the value, and tell the subscribers if it changed. */
  set: (value: T) => void;
};

/**
 * Make a {@link WritableStore} holding `initial`. Its functions are bound, so
 * they can be passed around on their own (for example to
 * `useSyncExternalStore`).
 */
export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The part of `store` that `select` picks, as a {@link ReadableStore} that
 * tells its subscribers only when that part changes (by `Object.is`). A
 * binding that keys work on one field of a larger state, like the arguments
 * of a query subscription, reads that field through it, so the other fields
 * don't restart the work.
 *
 * `select` must return a field of the value, not build a new object: `get`
 * runs it on every read, and a new object on each read breaks the
 * {@link ReadableStore} rule that reads without a change are equal.
 */
export function selectStore<T, U>(
  store: ReadableStore<T>,
  select: (value: T) => U,
): ReadableStore<U> {
  return {
    get: () => select(store.get()),
    subscribe: (listener) => {
      let last = select(store.get());
      return store.subscribe(() => {
        const next = select(store.get());
        if (Object.is(next, last)) return;
        last = next;
        listener();
      });
    },
  };
}

/**
 * A `pending` flag that is `true` while at least one call of `track` runs.
 * The count is a safety net: apps should not start a flow twice at once (they
 * disable the form while it runs), but if they do, `pending` stays `true`
 * until the last call is done.
 */
export function createPendingTracker(): {
  pending: ReadableStore<boolean>;
  track: <T>(work: () => Promise<T>) => Promise<T>;
} {
  const pending = createStore(false);
  let inFlight = 0;
  return {
    pending: { get: pending.get, subscribe: pending.subscribe },
    track: async (work) => {
      inFlight++;
      pending.set(true);
      try {
        return await work();
      } finally {
        if (--inFlight === 0) pending.set(false);
      }
    },
  };
}
