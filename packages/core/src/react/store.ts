"use client";

import {
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReadableStore } from "../browser/store.ts";

/**
 * Read a {@link ReadableStore} of a method client, and render again when it
 * changes. The store is made in the browser and on the server alike, so the
 * server snapshot is the same read.
 */
export function useReadableStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Make the client of a method flow once per hook instance, so the state of
 * the client (its `pending`, the progress of a link flow) lives as long as
 * the component, like the `useState` of a hook would.
 *
 * The client reads its options when it uses them, and this hands it the
 * options of the latest committed render. A callback of the client thus runs
 * with the arguments of the hook that the UI shows, the way a `useCallback`
 * over them would, without its identity ever changing. A render that React
 * throws away never reaches the client.
 */
export function useMethodClient<Options extends object, Client>(
  create: (options: Options) => Client,
  options: Options,
): Client {
  // Read through a ref: the arguments of the hook change identity on every
  // render (an inline `api` object, for example), and the client must not be
  // made again for that.
  const latest = useRef(options);
  // Before any layout effect, so a child's layout effect that calls the
  // client already sees the new options.
  useInsertionEffect(() => {
    latest.current = options;
  });
  const [client] = useState(() =>
    create(
      new Proxy({} as Options, {
        get: (_target, key) => latest.current[key as keyof Options],
      }),
    ),
  );
  return client;
}
