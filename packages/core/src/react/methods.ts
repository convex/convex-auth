/**
 * React building blocks that the sign-in methods use to expose their state as
 * hooks. This module is internal: it is not a public entry point, and apps
 * do not use it.
 *
 * TODO(nicolas) Publish this module at
 * `@convex-dev/auth/methods/custom/react` (with a matching `/server` entry
 * point) when the API for custom sign-in methods is stable.
 *
 * An ambient sign-in publishes its actions and status from its
 * {@link AmbientSignInClient} (registered by the auth client factories); its
 * hooks read them back with {@link useAmbientSignInValue}.
 *
 * @module
 */
"use client";

import { useCallback, useContext, useSyncExternalStore } from "react";
import { AuthClientContext } from "./client.tsx";

export type {
  AmbientSignInClient,
  AmbientSignInContext,
} from "../browser/ambientSignInClient.ts";
export type { AuthSignInApi } from "../browser/signInApi.ts";

/**
 * Subscribe to a value published by the ambient sign-in registered as `id`
 * (the same scope its setup writes through). Returns `undefined` when nothing
 * is registered at `key`, typically meaning the sign-in wasn't passed to
 * `ConvexAuthProvider`'s `ambientSignIns` prop, which provider hooks should
 * surface as an error.
 */
export function useAmbientSignInValue<T>(
  id: string,
  key: string,
): T | undefined {
  const client = useContext(AuthClientContext);
  if (client === undefined) {
    throw new Error(
      "useAmbientSignInValue must be used within a <ConvexAuthProvider>.",
    );
  }
  const subscribe = useCallback(
    (listener: () => void) =>
      client.ambientSignInValues(id).subscribe(key, listener),
    [client, id, key],
  );
  const getSnapshot = useCallback(
    // The values are already published during SSR, so the server snapshot is
    // the same read.
    () => client.ambientSignInValues(id).get<T>(key),
    [client, id, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
