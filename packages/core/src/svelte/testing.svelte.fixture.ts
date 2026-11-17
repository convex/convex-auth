/**
 * Helpers for the tests of the Svelte bindings: run a helper in a component
 * with the context of the bindings, and watch its reactive values.
 *
 * @module
 */

import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { flushSync, mount, unmount } from "svelte";
import { vi } from "vitest";
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

/** A query subscription of a {@link fakeConvexClient}. */
type FakeSubscription = {
  name: string;
  args: Record<string, unknown>;
  onUpdate: (value: unknown) => void;
  active: boolean;
};

/**
 * A stand-in for the `ConvexClient` that `convex-svelte` reads from its
 * context: enough for `useQuery` and `setupAuth`. `push` delivers a query
 * result to the subscriptions with the same arguments. The `onUpdate` and
 * `setAuth` mocks record the calls, and `unsubscribed` counts the
 * subscriptions that were closed.
 */
export function fakeConvexClient() {
  const key = (name: string, args: unknown) =>
    `${name}:${JSON.stringify(args)}`;
  const results = new Map<string, unknown>();
  const subscriptions: FakeSubscription[] = [];
  let unsubscribed = 0;
  const client = {
    disabled: false,
    closed: false,
    onUpdate: vi.fn(
      (
        query: FunctionReference<"query">,
        args: Record<string, unknown>,
        onUpdate: (value: unknown) => void,
      ) => {
        const subscription = {
          name: getFunctionName(query),
          args,
          onUpdate,
          active: true,
        };
        subscriptions.push(subscription);
        return () => {
          if (!subscription.active) return;
          subscription.active = false;
          unsubscribed++;
        };
      },
    ),
    setAuth: vi.fn(
      (
        _fetchToken: (args: {
          forceRefreshToken: boolean;
        }) => Promise<string | null | undefined>,
        _onChange?: (isAuthenticated: boolean) => void,
      ) => {},
    ),
    mutation: vi.fn(async () => null),
    action: vi.fn(async () => null),
    client: {
      localQueryResult: (name: string, args: unknown) =>
        results.get(key(name, args)),
    },
  };
  return {
    /** Pass it to `setConvexClientContext` of `convex-svelte`. */
    client: client as unknown as ConvexClient,
    onUpdate: client.onUpdate,
    setAuth: client.setAuth,
    /** The number of subscriptions closed so far. */
    unsubscribed: () => unsubscribed,
    /** The active subscriptions to the query `name`. */
    subscriptions: (name: string) =>
      subscriptions.filter((s) => s.active && s.name === name),
    /** Deliver the result `value` of the query `name` with `args`. */
    push(name: string, args: Record<string, unknown>, value: unknown) {
      results.set(key(name, args), value);
      for (const s of subscriptions) {
        if (s.active && key(s.name, s.args) === key(name, args)) {
          s.onUpdate(value);
        }
      }
    },
  };
}
