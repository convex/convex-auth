/**
 * Helpers for the tests of the Svelte bindings: run a helper in a component
 * with the context of the bindings, and watch its reactive values.
 *
 * @module
 */

import { flushSync, mount, unmount } from "svelte";
import type { ConvexAuthContext } from "./client.svelte.ts";
import Harness from "./Harness.test.svelte";

/**
 * Call `helper` during the initialization of a mounted component that has
 * `context` (none when `undefined`), and return what it returns. `destroy`
 * unmounts the component.
 */
export function mountHelper<T>(
  context: Partial<ConvexAuthContext> | undefined,
  helper: () => T,
): { result: T; destroy: () => void } {
  let result: T | undefined;
  const component = mount(Harness, {
    target: document.body,
    props: {
      context: context as ConvexAuthContext | undefined,
      setup: () => {
        result = helper();
      },
    },
  });
  flushSync();
  return { result: result as T, destroy: () => void unmount(component) };
}

/**
 * Record each value that `read` returns in an effect, as a template that
 * reads it would see it. Returns the values and the function that stops.
 */
export function watch<T>(read: () => T): { values: T[]; stop: () => void } {
  const values: T[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      values.push(read());
    });
  });
  flushSync();
  return { values, stop };
}
