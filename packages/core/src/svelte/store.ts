/**
 * The store-to-runes adapter of the Svelte bindings: the counterpart of
 * `useReadableStore` in `react/store.ts`. The method helpers read the state
 * of their framework-agnostic clients through it.
 *
 * @module
 */

import { onMount } from "svelte";
import { createSubscriber } from "svelte/reactivity";
import type { LinkFlowClient } from "../browser/linkFlow.ts";
import type { ReadableStore } from "../browser/store.ts";

/**
 * Read a {@link ReadableStore} as Svelte state: `current` is the value of the
 * store, and an effect or a template that reads it runs again when it
 * changes. The subscription lives as long as something reads `current` in an
 * effect. Read outside of one, `current` is the value of the store.
 */
export function fromReadableStore<T>(store: ReadableStore<T>): {
  readonly current: T;
} {
  const track = createSubscriber((update) => store.subscribe(update));
  return {
    get current() {
      track();
      return store.get();
    },
  };
}

/** The `pending` flag of a helper, read through a getter. */
export function pendingOf(store: ReadableStore<boolean>): {
  readonly pending: boolean;
} {
  const pending = fromReadableStore(store);
  return {
    get pending() {
      return pending.current;
    },
  };
}

/** Start a landing page on mount, and return its state as `{ current }`. */
export function landingPage<State>(client: LinkFlowClient<State>): {
  readonly current: State;
} {
  onMount(() => client.start());
  return fromReadableStore(client.state);
}
