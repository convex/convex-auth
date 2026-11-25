/**
 * The framework-agnostic client of the passkey sign-in page: the
 * identifier-first flow and passkey autofill, one modal ceremony at a time.
 * The React hook of `hooks.tsx` wraps it, and so can a binding for another
 * framework.
 *
 * Like `autofill.ts`, it takes the ceremonies of the platform as an option,
 * and never imports `client.ts` or `@simplewebauthn/browser`.
 *
 * @module
 */

import { createStore, type ReadableStore } from "../../browser/store.ts";
import type { SignInError } from "../../lib/types.ts";
import {
  createPasskeyAutofill,
  createPasskeyCeremonySlot,
  type AlreadyPendingError,
  type AlreadyPendingFailure,
  type PasskeyAutofillState,
} from "./autofill.ts";
import type { PasskeyClientError, PasskeyClientFailure } from "./ceremonies.ts";
import {
  runSignInOrSignUpFlow,
  type SignInFlowResult,
  type SignInWithUsernamePasskeyOptions,
  type UsernamePasskeyAutofillError,
} from "./flows.ts";

export type { SignInWithUsernamePasskeyOptions } from "./flows.ts";

/**
 * The result of `signIn` of the passkey sign-in page.
 *
 * A completed sign-in carries a `flow` discriminant: `"signUp"` when the
 * ceremony created a new account, `"signIn"` when it authenticated an existing
 * one. `ALREADY_PENDING` comes back when a `signIn` call runs while the
 * previous one still does, or while an autofill sign-in is verified.
 */
export type SignInWithUsernamePasskeyResult =
  SignInFlowResult | SignInError<PasskeyClientError | AlreadyPendingError>;

/** The client of the passkey sign-in page. */
export type SignInWithUsernamePasskeyClient = {
  /**
   * Run the identifier-first passkey flow for the given username: a new
   * username makes an account with a new passkey, a known one asks for its
   * passkey. Resolves to a result with a `status` field, and never rejects.
   */
  signIn: (args: {
    username: string;
  }) => Promise<SignInWithUsernamePasskeyResult>;
  /**
   * `true` while a sign-in runs: a `signIn` call, or an autofill sign-in
   * that the server verifies (`autofill.status` is `"signingIn"`). A
   * `signIn` call in this time returns `ALREADY_PENDING`.
   */
  pending: ReadableStore<boolean>;
  /** The state of the autofill flow. */
  autofill: ReadableStore<PasskeyAutofillState<UsernamePasskeyAutofillError>>;
  /**
   * Start the autofill request, which lets the browser offer the stored
   * passkeys in the autocompletion list of the username field. Call it when
   * the page mounts. Returns the function that stops it, for the unmount.
   * The browser allows one such request at a time, so start one per page.
   */
  startAutofill: () => () => void;
};

/**
 * Make the client of the passkey sign-in page. It reads its options when it
 * uses them, so a binding can pass getters.
 */
export function createSignInWithUsernamePasskey(
  options: SignInWithUsernamePasskeyOptions,
): SignInWithUsernamePasskeyClient {
  const autofill = createPasskeyAutofill<UsernamePasskeyAutofillError>({
    get ceremonies() {
      return options.ceremonies;
    },
    start: async () => {
      const { options: requestOptions } = await options.convex.mutation(
        options.api.startAutofillSignInWithUsernamePasskey,
        {},
      );
      return requestOptions;
    },
    onAssertion: async (response) => {
      const result = await options.signInApi.mutation(
        options.api.finishSignInWithUsernamePasskey,
        { response },
      );
      if (result.status !== "complete") {
        // The autofill loop takes its own `success` boolean, not the
        // envelope: it retries on a failed assertion rather than handing
        // the arm back to the caller.
        return { success: false, userError: result.userError };
      }
      await options.authClient.setSession(result.tokens);
      return { success: true };
    },
  });

  const slot = createPasskeyCeremonySlot({ autofill });

  const signIn = async ({
    username,
  }: {
    username: string;
  }): Promise<SignInWithUsernamePasskeyResult> => {
    const signInResult = await slot.run(() =>
      runSignInOrSignUpFlow(options, { username }),
    );
    if ("status" in signInResult) {
      // This is the result of `runSignInOrSignUpFlow`. It can be directly
      // returned.
      return signInResult;
    }
    // The slot is generic and can return a `success: false` error. We
    // handle that here and package it as a sign-in failure with
    // `status: "error"`.
    signInResult satisfies PasskeyClientFailure | AlreadyPendingFailure;
    return { status: "error", userError: signInResult.userError };
  };

  // A sign-in runs: a `signIn` call, or an autofill pick that the server
  // verifies. The store tells only when the combined value changes.
  const pending = createStore(false);
  const updatePending = () =>
    pending.set(
      slot.pending.get() || autofill.state.get().status === "signingIn",
    );
  slot.pending.subscribe(updatePending);
  autofill.state.subscribe(updatePending);

  return {
    signIn,
    pending: { get: pending.get, subscribe: pending.subscribe },
    autofill: autofill.state,
    startAutofill: autofill.start,
  };
}
