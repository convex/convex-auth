/**
 * React client for the `usernamePasskey` method, exported at
 * `@convex-dev/auth/methods/username-passkey/react`.
 *
 * {@link useSignInWithUsernamePasskey} is the batteries-included hook for the
 * username + passkey login form. It drives the browser-side WebAuthn
 * ceremonies (through the internal client module built on
 * `@simplewebauthn/browser`) against the mutations of a passkey recipe,
 * and it handles both the identifier-first modal flow and passkey autofill
 * (conditional mediation), where the user selects an account directly in
 * the autocompletion list.
 *
 * {@link useAddPasskey} and {@link useRemovePasskey} (from
 * `management/react.tsx`) drive the passkey settings page of a signed-in
 * user.
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
} from "./react_impl.tsx";
import { PasskeyClientError, PasskeyClientFailure } from "./client.ts";
import { SignInError } from "../../lib/types.ts";

export type { RenamePasskeyResult } from "./management/rename.ts";
export {
  useAddPasskey,
  useRemovePasskey,
  type AddPasskeyApi,
  type AddPasskeyResult,
  type RemovePasskeyApi,
  type RemovePasskeyResult,
} from "./management/react.tsx";
// Apps read the WebAuthn JSON types and the browser-side failure shapes
// from here, so they never depend on `@simplewebauthn/*` directly.
export type {
  AuthenticationResponseJSON,
  PasskeyClientError,
  PasskeyClientFailure,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "./client.ts";
export type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "./react_impl.tsx";

/**
 * The result of the `signIn` callback from {@link useSignInWithUsernamePasskey}.
 *
 * A completed sign-in carries a `flow` discriminant: `"signUp"` when the
 * ceremony created a new account, `"signIn"` when it authenticated an existing
 * one. `ALREADY_PENDING` comes back when a `signIn` call runs while the
 * previous one still does, or while an autofill sign-in is verified.
 */
export type SignInWithUsernamePasskeyResult =
  SignInFlowResult | SignInError<PasskeyClientError | AlreadyPendingError>;

/**
 * Client for the log in page in the “username + passkey” auth flow.
 *
 * This client handles both:
 * - Manually logging in by providing an identifier (e.g. username)
 *   then registering a new passkey or logging in
 * - Passkey autofill (conditional mediation) where the user selects an account
 *   directly in the autocompletion list.
 *
 * ```tsx
 * import { useSignInWithUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/react";
 * import { useState } from "react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   // While this hook is mounted, the browser also shows the stored passkeys
 *   // in the autocompletion list of the username field.
 *   const { signIn, pending, autofill } = useSignInWithUsernamePasskey(api.auth);
 *   const [username, setUsername] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   // The alerts show the error codes. Map each code to a message for the user.
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         setError(null);
 *         const result = await signIn({ username });
 *         if (result.status === "error") {
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <input
 *         type="text"
 *         value={username}
 *         onChange={(e) => setUsername(e.target.value)}
 *         autoComplete="username webauthn"
 *         required
 *         disabled={pending}
 *       />
 *       {error !== null && <p role="alert">{error}</p>}
 *       {autofill.lastError !== null && (
 *         <p role="alert">{autofill.lastError.error}</p>
 *       )}
 *       <button type="submit" disabled={pending}>
 *         {pending ? "Waiting for your passkey…" : "Continue with a passkey"}
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param usernamePasskeyApi The functions of the method, usually `api.auth`.
 */
export function useSignInWithUsernamePasskey(
  usernamePasskeyApi: UsernamePasskeyApi,
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
    }),
    [
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
       * - `available`: whether the browser can offer passkeys in the
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
