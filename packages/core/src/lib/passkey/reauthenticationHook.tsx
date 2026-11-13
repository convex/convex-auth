/**
 * The shared body of the `useReauthenticateWithPasskey` hook of both passkey
 * methods. Each entry point binds it to the ceremonies of its platform.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useMemo } from "react";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import type { ResolvedPasskeyCeremonies } from "./ceremonies.ts";
import {
  usePasskeyCeremonySlot,
  type AlreadyPendingFailure,
} from "./react_impl.tsx";
import {
  runPasskeyReauthenticationFlow,
  type PasskeyReauthenticationApi,
  type PasskeyReauthenticationFlowResult,
} from "./reauthenticationFlow.ts";

export type { PasskeyReauthenticationApi } from "./reauthenticationFlow.ts";

export type ReauthenticateWithPasskeyResult =
  PasskeyReauthenticationFlowResult | AlreadyPendingFailure;

/**
 * The body of `useReauthenticateWithPasskey`, for the given platform.
 *
 * @param reauthenticationApi The re-authentication functions, usually
 *   `api.auth` or `api.passkey`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useReauthenticateWithPasskeyImpl(
  reauthenticationApi: PasskeyReauthenticationApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const convex = useConvex();
  const { run, pending } = usePasskeyCeremonySlot({ autofill: null });

  const startPasskeyReauthentication = useStableFunctionReference(
    reauthenticationApi.startPasskeyReauthentication,
  );
  const finishPasskeyReauthentication = useStableFunctionReference(
    reauthenticationApi.finishPasskeyReauthentication,
  );
  const ctx = useMemo(
    () => ({
      convex,
      api: { startPasskeyReauthentication, finishPasskeyReauthentication },
      ceremonies,
    }),
    [
      convex,
      startPasskeyReauthentication,
      finishPasskeyReauthentication,
      ceremonies,
    ],
  );

  const reauthenticate = useCallback(
    (): Promise<ReauthenticateWithPasskeyResult> =>
      run(() => runPasskeyReauthenticationFlow(ctx)),
    [run, ctx],
  );

  return {
    /**
     * Asks the signed-in user for one of their passkeys, and records it as a
     * new authentication of the current session.
     *
     * Returns an object with a `success` boolean flag. If it is `false`,
     * the object has a `userError` field that tells why.
     */
    reauthenticate,
    /** `true` while a `reauthenticate` call is running. */
    pending,
  };
}
