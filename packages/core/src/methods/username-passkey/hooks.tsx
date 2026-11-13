/**
 * The shared body of the passkey sign-in hook. Each entry point binds it to
 * the {@link ResolvedPasskeyCeremonies} of its platform.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useMemo } from "react";
import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import {
  runSignInOrSignUpFlow,
  type UsernamePasskeyApi,
  type UsernamePasskeyAutofillError,
  type SignInFlowResult,
} from "./flows.ts";
import {
  AlreadyPendingError,
  AlreadyPendingFailure,
  usePasskeyAutofill,
  usePasskeyCeremonySlot,
} from "../../lib/passkey/react_impl.tsx";
import {
  ResolvedPasskeyCeremonies,
  PasskeyClientError,
  PasskeyClientFailure,
} from "../../lib/passkey/ceremonies.ts";
import { SignInError } from "../../lib/types.ts";

/**
 * The result of the `signIn` callback from `useSignInWithUsernamePasskey`.
 *
 * A completed sign-in carries a `flow` discriminant: `"signUp"` when the
 * ceremony created a new account, `"signIn"` when it authenticated an existing
 * one. `ALREADY_PENDING` comes back when a `signIn` call runs while the
 * previous one still does, or while an autofill sign-in is verified.
 */
export type SignInWithUsernamePasskeyResult =
  SignInFlowResult | SignInError<PasskeyClientError | AlreadyPendingError>;

/**
 * The body of `useSignInWithUsernamePasskey`, for the given platform.
 *
 * @param usernamePasskeyApi The functions of the method, usually `api.auth`.
 * @param ceremonies The passkey ceremonies of the platform. Pass a module
 *   constant, so its identity never changes.
 */
export function useSignInWithUsernamePasskeyImpl(
  usernamePasskeyApi: UsernamePasskeyApi,
  ceremonies: ResolvedPasskeyCeremonies,
) {
  const { setSession } = useAuthActions();

  // Using useAuthSignInApi for mutations that return a session to support SSR
  const signInApi = useAuthSignInApi();
  const convex = useConvex();

  const startSignIn = useStableFunctionReference(
    usernamePasskeyApi.startSignInWithUsernamePasskey,
  );
  const startAutofillSignIn = useStableFunctionReference(
    usernamePasskeyApi.startAutofillSignInWithUsernamePasskey,
  );
  const finishSignIn = useStableFunctionReference(
    usernamePasskeyApi.finishSignInWithUsernamePasskey,
  );
  const finishSignUp = useStableFunctionReference(
    usernamePasskeyApi.finishSignUpWithUsernamePasskey,
  );
  const ctx = useMemo(
    () => ({
      convex,
      api: {
        startSignInWithUsernamePasskey: startSignIn,
        startAutofillSignInWithUsernamePasskey: startAutofillSignIn,
        finishSignInWithUsernamePasskey: finishSignIn,
        finishSignUpWithUsernamePasskey: finishSignUp,
      },
      signInApi,
      setSession,
      ceremonies,
    }),
    [
      ceremonies,
      convex,
      startSignIn,
      startAutofillSignIn,
      finishSignIn,
      finishSignUp,
      signInApi,
      setSession,
    ],
  );

  const autofill = usePasskeyAutofill<UsernamePasskeyAutofillError>({
    ceremonies,
    start: async () => {
      const { options } = await convex.mutation(startAutofillSignIn, {});
      return options;
    },
    onAssertion: async (response) => {
      const result = await signInApi.mutation(finishSignIn, { response });
      if (result.status !== "complete") {
        // The autofill loop takes its own `success` boolean, not the
        // envelope: it retries on a failed assertion rather than handing
        // the arm back to the caller.
        return { success: false, userError: result.userError };
      }

      await setSession(result.tokens);
      return { success: true };
    },
  });

  const { run, pending } = usePasskeyCeremonySlot({ autofill });

  const signIn = useCallback(
    async ({
      username,
    }: {
      username: string;
    }): Promise<SignInWithUsernamePasskeyResult> => {
      const signInResult = await run(() =>
        runSignInOrSignUpFlow(ctx, { username }),
      );
      if ("status" in signInResult) {
        // This is the result of `runSignInOrSignUpFlow`. It can be directly
        // returned.
        return signInResult;
      }
      // The `run` wrapper is generic and can return a `success: false` error.
      // We handle that here and package it as a sign-in failure with
      // `status: "error"`.
      signInResult satisfies PasskeyClientFailure | AlreadyPendingFailure;
      return { status: "error", userError: signInResult.userError };
    },
    [run, ctx],
  );

  return useMemo(
    () => ({
      /**
       * Runs the identifier-first passkey flow for the given username.
       *
       * Returns an object with a `status` field.
       *
       * If it is `"complete"` the sign-in (or the account creation) was
       * successful and the client will establish an authenticated session
       * with the Convex backend server. The `flow` field tells which one
       * it was: `"signUp"` created a new account, `"signIn"` authenticated
       * an existing one.
       *
       * If it is `"error"` the returned object will have a `userError` field
       * with additional details about why sign-in failed.
       */
      signIn,
      /**
       * `true` while a sign-in runs: a `signIn` call, or an autofill
       * sign-in that the server verifies (`autofill.status` is
       * `"signingIn"`). A `signIn` call in this time returns
       * `ALREADY_PENDING`.
       */
      pending: pending || autofill.status === "signingIn",
      /**
       * The state of the autofill flow:
       *
       * - `available`: whether the platform can offer passkeys in the
       *   autocompletion list; `null` while the detection runs.
       * - `status`: the state of the request; see
       *   {@link PasskeyAutofillStatus}.
       * - `lastError`: the most recent failure, for display or logging.
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
