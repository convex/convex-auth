/**
 * The shared bodies of the hooks of the `passkey` method. Each entry point
 * binds them to the ceremonies of its platform.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useMemo } from "react";
import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import type { SignInError } from "../../lib/types.ts";
import type {
  PasskeyClientError,
  ResolvedPasskeyCeremonies,
} from "../username-passkey/ceremonies.ts";
import {
  usePasskeyAutofill,
  usePasskeyCeremonySlot,
  type AlreadyPendingError,
  type AlreadyPendingFailure,
} from "../username-passkey/react_impl.tsx";
import {
  runAddPasskeyFlow,
  runSignInWithPasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type PasskeyAutofillError,
  type PasskeySignInApi,
  type SignInWithPasskeyFlowResult,
} from "./flows.ts";

/**
 * The result of the `signIn` callback of `useSignInWithPasskey`.
 * `ALREADY_PENDING` comes back when a `signIn` call runs while the previous
 * one still does, or while an autofill sign-in is verified.
 */
export type SignInWithPasskeyResult =
  | SignInWithPasskeyFlowResult
  | SignInError<PasskeyClientError | AlreadyPendingError>;

/** The result of the `addPasskey` callback of `useAddPasskey`. */
export type AddPasskeyResult = AddPasskeyFlowResult | AlreadyPendingFailure;

/**
 * The body of `useSignInWithPasskey`, for the given platform.
 *
 * @param passkeyApi The functions of the method, usually `api.passkey`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useSignInWithPasskeyImpl(
  passkeyApi: PasskeySignInApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const { setSession } = useAuthActions();
  // The finishing mutation mints a session, thus it goes through the sign-in
  // API, which works under both session models (SPA and SSR).
  const signInApi = useAuthSignInApi();
  const convex = useConvex();

  const startSignIn = useStableFunctionReference(
    passkeyApi.startSignInWithPasskey,
  );
  const finishSignIn = useStableFunctionReference(
    passkeyApi.finishSignInWithPasskey,
  );
  const ctx = useMemo(
    () => ({
      convex,
      api: {
        startSignInWithPasskey: startSignIn,
        finishSignInWithPasskey: finishSignIn,
      },
      signInApi,
      setSession,
      ceremonies,
    }),
    [ceremonies, convex, startSignIn, finishSignIn, signInApi, setSession],
  );

  const autofill = usePasskeyAutofill<PasskeyAutofillError>({
    ceremonies,
    start: async () => {
      const { options } = await convex.mutation(startSignIn, {});
      return options;
    },
    onAssertion: async (response) => {
      const result = await signInApi.mutation(finishSignIn, { response });
      if (result.status !== "complete") {
        return { success: false, userError: result.userError };
      }
      await setSession(result.tokens);
      return { success: true };
    },
  });

  const { run, pending } = usePasskeyCeremonySlot({ autofill });

  const signIn = useCallback(async (): Promise<SignInWithPasskeyResult> => {
    const result = await run(() => runSignInWithPasskeyFlow(ctx));
    if ("status" in result) {
      return result;
    }
    // The `run` wrapper reports its own failures with `success: false`.
    return { status: "error", userError: result.userError };
  }, [run, ctx]);

  return useMemo(
    () => ({
      /**
       * Asks the browser for a passkey of this app and signs in its owner.
       *
       * Returns an object with a `status` field: `"complete"` when the user
       * is signed in, `"error"` with a `userError` otherwise.
       */
      signIn,
      /**
       * `true` while a sign-in runs: a `signIn` call, or an autofill
       * sign-in that the server verifies.
       */
      pending: pending || autofill.status === "signingIn",
      /**
       * The state of the autofill flow. The browser offers the passkeys in
       * the autocompletion list of a field with
       * `autoComplete="username webauthn"`.
       */
      autofill: {
        available: autofill.available,
        status: autofill.status,
        lastError: autofill.lastError,
      },
    }),
    [signIn, pending, autofill],
  );
}

/**
 * The body of `useAddPasskey`, for the given platform.
 *
 * @param addPasskeyApi The add functions of the method, usually
 *   `api.passkey`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useAddPasskeyImpl(
  addPasskeyApi: AddPasskeyApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const convex = useConvex();
  const { run, pending } = usePasskeyCeremonySlot({ autofill: null });

  const startAddPasskey = useStableFunctionReference(
    addPasskeyApi.startAddPasskey,
  );
  const finishAddPasskey = useStableFunctionReference(
    addPasskeyApi.finishAddPasskey,
  );
  const ctx = useMemo(
    () => ({
      convex,
      api: { startAddPasskey, finishAddPasskey },
      ceremonies,
    }),
    [convex, startAddPasskey, finishAddPasskey, ceremonies],
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
     * the object has a `userError` field that tells why. On
     * `REAUTHENTICATION_REQUIRED`, ask the user to re-authenticate, then
     * try again.
     */
    addPasskey,
    /** `true` while an `addPasskey` call is running. */
    pending,
  };
}
