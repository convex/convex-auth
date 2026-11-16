"use client";

import { useSyncExternalStore } from "react";
import type { ReadableStore } from "../browser/store.ts";

/**
 * Read a {@link ReadableStore} of a method client, and render again when it
 * changes. The store is made in the browser and on the server alike, so the
 * server snapshot is the same read.
 */
export function useReadableStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
