/**
 * The shared bodies of the passkey-management hooks, `useAddPasskey` and
 * `useRemovePasskey`. Each entry point binds them to the ceremonies of its
 * platform. They wrap the framework-agnostic {@link createAddPasskey} and
 * {@link createRemovePasskey}.
 *
 * There is no list hook: `listPasskeys` is a plain reactive query, so a
 * page simply reads it with `useQuery(api.auth.listPasskeys, {})`.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useMethodClient, useReadableStore } from "../../../react/store.ts";
import type { ResolvedPasskeyCeremonies } from "../ceremonies.ts";
import type { AddPasskeyApi, RemovePasskeyApi } from "./flows.ts";
import { createAddPasskey, createRemovePasskey } from "./managementClient.ts";

export type { AlreadyPendingFailure } from "../autofill.ts";
export type { AddPasskeyApi, RemovePasskeyApi } from "./flows.ts";
export type {
  AddPasskeyResult,
  RemovePasskeyResult,
} from "./managementClient.ts";

/**
 * The body of `useAddPasskey`, for the given platform.
 *
 * @param managementApi The passkey-management functions, usually `api.auth`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useAddPasskeyImpl(
  managementApi: AddPasskeyApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const client = useMethodClient(createAddPasskey, {
    convex: useConvex(),
    api: managementApi,
    ceremonies,
  });
  return {
    /**
     * Adds a passkey to the account of the signed-in user.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    addPasskey: client.addPasskey,
    /** `true` while an `addPasskey` call is running. */
    pending: useReadableStore(client.pending),
  };
}

/**
 * The body of `useRemovePasskey`, for the given platform.
 *
 * @param managementApi The passkey-management functions, usually `api.auth`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useRemovePasskeyImpl(
  managementApi: RemovePasskeyApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const client = useMethodClient(createRemovePasskey, {
    convex: useConvex(),
    api: managementApi,
    ceremonies,
  });
  return {
    /**
     * Removes the given passkey from the account of the signed-in user.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    removePasskey: client.removePasskey,
    /** `true` while a `removePasskey` call is running. */
    pending: useReadableStore(client.pending),
  };
}
