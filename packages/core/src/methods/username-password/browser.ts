/**
 * Framework-agnostic client for the `usernamePassword` method, exported at
 * `@convex-dev/auth/methods/username-password/browser`. The React hooks of
 * `@convex-dev/auth/methods/username-password/react` wrap it, and a binding
 * for another framework can too.
 *
 * Each factory makes the client of one flow: a function that sends up the
 * credentials and, on success, hands the session to the `AuthClient`, plus a
 * {@link ReadableStore} for `pending`. Make one per form (per component
 * instance), so that each form keeps its own `pending`.
 *
 * ```ts
 * import { createSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/browser";
 * import type { AuthClient, AuthSignInApi } from "@convex-dev/auth/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 * declare const signInApi: AuthSignInApi;
 *
 * // One client per form.
 * const login = createSignInWithUsernamePassword({
 *   authClient,
 *   signInApi,
 *   api: api.auth,
 * });
 * // Bind `pending` to the framework, for example to disable the form.
 * const unsubscribe = login.pending.subscribe(() => {
 *   console.log("pending:", login.pending.get());
 * });
 *
 * async function onSubmit(username: string, password: string) {
 *   const result = await login.signIn({ username, password });
 *   if (result.status === "error") {
 *     // map result.userError (INVALID_CREDENTIALS, OTHER_ERROR, …) to a message
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 *
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import {
  runSignInMutation,
  type SignInUnexpectedFailure,
} from "../../browser/signInMutation.ts";
import {
  createPendingTracker,
  type ReadableStore,
} from "../../browser/store.ts";
import type { ClientView } from "../../lib/types.ts";
import type { SignInResult, SignUpResult } from "./server.ts";

export type { ReadableStore } from "../../browser/store.ts";

/** The `(username, password)` pair both flows accept. */
export type Credentials = { username: string; password: string };

/**
 * The `signInWithUsernamePassword` mutation the app re-exports from its
 * `setupUsernamePassword`.
 *
 * Its return value is the access-only {@link ClientView}, which is what both
 * session models have in common.
 */
export type SignInWithUsernamePasswordMutation = FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<SignInResult>
>;

/**
 * The `signUpWithUsernamePassword` mutation the app re-exports from its
 * `setupUsernamePassword`.
 */
export type SignUpWithUsernamePasswordMutation = FunctionReference<
  "mutation",
  "public",
  Credentials,
  ClientView<SignUpResult>
>;

/**
 * A failure the client produces that the server never returns: the mutation
 * threw (a network blip, a bug, an unexpected server error) rather than
 * resolving to a `userError`. The flows fold that into the result as
 * `OTHER_ERROR` so callers handle *every* failure through the one `userError`
 * switch and never need their own `try`/`catch`. The thrown value is preserved
 * on `cause` for callers that want to inspect or log it.
 */
export type UnexpectedFailure = SignInUnexpectedFailure;

/** The result of `signIn` from {@link createSignInWithUsernamePassword}. */
export type SignInWithUsernamePasswordResult =
  ClientView<SignInResult> | UnexpectedFailure;

/** The result of `signUp` from {@link createSignUpWithUsernamePassword}. */
export type SignUpWithUsernamePasswordResult =
  ClientView<SignUpResult> | UnexpectedFailure;

/** What the factories of this module need from the binding. */
export type UsernamePasswordClientOptions<Api> = {
  /** The client the session goes to. */
  authClient: Pick<AuthClient, "setSession">;
  /**
   * Runs the mutation. It mints a session, so under SSR it goes through the
   * auth proxy.
   */
  signInApi: AuthSignInApi;
  /** The functions of the method, usually `api.auth`. */
  api: Api;
};

/** The client of the sign-in flow. */
export type SignInWithUsernamePasswordClient = {
  /**
   * Send up the credentials. On success, the session goes to the
   * `AuthClient`. Resolves to a result with a `status` field, and never
   * rejects: a thrown error comes back as `OTHER_ERROR`.
   */
  signIn: (
    credentials: Credentials,
  ) => Promise<SignInWithUsernamePasswordResult>;
  /** `true` while the credentials are being validated. */
  pending: ReadableStore<boolean>;
};

/** The client of the sign-up flow. */
export type SignUpWithUsernamePasswordClient = {
  /**
   * Send up the credentials of the new account. On success, the session
   * goes to the `AuthClient`. Resolves to a result with a `status` field, and
   * never rejects: a thrown error comes back as `OTHER_ERROR`.
   */
  signUp: (
    credentials: Credentials,
  ) => Promise<SignUpWithUsernamePasswordResult>;
  /** `true` while the credentials are being validated. */
  pending: ReadableStore<boolean>;
};

/**
 * Make the client of the sign-in flow: run the `signInWithUsernamePassword`
 * mutation and, on success, adopt the session.
 */
export function createSignInWithUsernamePassword(
  options: UsernamePasswordClientOptions<{
    signInWithUsernamePassword: SignInWithUsernamePasswordMutation;
  }>,
): SignInWithUsernamePasswordClient {
  const { pending, track } = createPendingTracker();
  // The options are read when used, so a binding can pass getters.
  const signIn = (credentials: Credentials) =>
    track(() =>
      runSignInMutation(
        options,
        options.api.signInWithUsernamePassword,
        credentials,
      ),
    );
  return { signIn, pending };
}

/**
 * Make the client of the sign-up flow: run the `signUpWithUsernamePassword`
 * mutation and, on success, adopt the session.
 */
export function createSignUpWithUsernamePassword(
  options: UsernamePasswordClientOptions<{
    signUpWithUsernamePassword: SignUpWithUsernamePasswordMutation;
  }>,
): SignUpWithUsernamePasswordClient {
  const { pending, track } = createPendingTracker();
  const signUp = (credentials: Credentials) =>
    track(() =>
      runSignInMutation(
        options,
        options.api.signUpWithUsernamePassword,
        credentials,
      ),
    );
  return { signUp, pending };
}
