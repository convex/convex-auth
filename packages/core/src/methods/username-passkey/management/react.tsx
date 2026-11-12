/**
 * The shared bodies of the passkey-management hooks, `useAddPasskey` and
 * `useRemovePasskey`. Each entry point binds them to the ceremonies of its
 * platform.
 *
 * There is no list hook: `listPasskeys` is a plain reactive query, so a
 * page simply reads it with `useQuery(api.auth.listPasskeys, {})`.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useMemo } from "react";
import { useStableFunctionReference } from "../../../react/functionReference.ts";
import type { ResolvedPasskeyCeremonies } from "../ceremonies.ts";
import {
  usePasskeyCeremonySlot,
  type AlreadyPendingFailure,
} from "../react_impl.tsx";
import {
  runAddPasskeyFlow,
  runRemovePasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type RemovePasskeyApi,
  type RemovePasskeyFlowResult,
} from "./flows.ts";

export type { AlreadyPendingFailure } from "../react_impl.tsx";
export type { AddPasskeyApi, RemovePasskeyApi } from "./flows.ts";

export type AddPasskeyResult = AddPasskeyFlowResult | AlreadyPendingFailure;

export type RemovePasskeyResult =
  RemovePasskeyFlowResult | AlreadyPendingFailure;

/**
 * The body of `useAddPasskey`, for the given platform.
 *
 * @param managementApi The passkey-management functions, usually `api.auth`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
// TODO(nicolas) Change the return value to allow showing a different UI before creating the new passkey
export function useAddPasskeyImpl(
  managementApi: AddPasskeyApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const convex = useConvex();

  const { run, pending } = usePasskeyCeremonySlot({
    // Not a log in page, so there is no autofill here
    autofill: null,
  });

  const startAddPasskey = useStableFunctionReference(
    managementApi.startAddPasskey,
  );
  const verifyAddPasskey = useStableFunctionReference(
    managementApi.verifyAddPasskey,
  );
  const finishAddPasskey = useStableFunctionReference(
    managementApi.finishAddPasskey,
  );
  const ctx = useMemo(
    () => ({
      convex,
      api: { startAddPasskey, verifyAddPasskey, finishAddPasskey },
      ceremonies,
    }),
    [convex, startAddPasskey, verifyAddPasskey, finishAddPasskey, ceremonies],
  );

  const addPasskey = useCallback(
    (): Promise<AddPasskeyResult> => run(() => runAddPasskeyFlow(ctx)),
    [run, ctx],
  );

  return {
    /**
     * Adds a passkey to the account of the signed-in user.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    addPasskey,
    /** `true` while an `addPasskey` call is running. */
    pending,
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
  const convex = useConvex();
  const { run, pending } = usePasskeyCeremonySlot({ autofill: null });

  const startRemovePasskey = useStableFunctionReference(
    managementApi.startRemovePasskey,
  );
  const finishRemovePasskey = useStableFunctionReference(
    managementApi.finishRemovePasskey,
  );
  const ctx = useMemo(
    () => ({
      convex,
      api: { startRemovePasskey, finishRemovePasskey },
      ceremonies,
    }),
    [convex, startRemovePasskey, finishRemovePasskey, ceremonies],
  );

  const removePasskey = useCallback(
    (passkeyId: string): Promise<RemovePasskeyResult> =>
      run(() => runRemovePasskeyFlow(ctx, { passkeyId })),
    [run, ctx],
  );

  return {
    /**
     * Removes the given passkey from the account of the signed-in user.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    removePasskey,
    /** `true` while a `removePasskey` call is running. */
    pending,
  };
}
