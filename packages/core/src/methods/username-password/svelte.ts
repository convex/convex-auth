/**
 * Svelte client for the `usernamePassword` method, exported at
 * `@convex-dev/auth/methods/username-password/svelte`: the counterpart of
 * `@convex-dev/auth/methods/username-password/react`.
 *
 * Each helper returns a function that sends the credentials and, on success,
 * adopts the session, plus a `pending` flag. Call the helpers during
 * component initialization, and read `pending` from the returned object
 * (don't destructure it), so it stays reactive.
 *
 * The helpers wrap the framework-agnostic clients of
 * `@convex-dev/auth/methods/username-password/browser`.
 *
 * @module
 */

import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import { fromReadableStore } from "../../svelte/store.ts";
import {
  createSignInWithUsernamePassword,
  createSignUpWithUsernamePassword,
  type Credentials,
  type SignInWithUsernamePasswordMutation,
  type SignInWithUsernamePasswordResult,
  type SignUpWithUsernamePasswordMutation,
  type SignUpWithUsernamePasswordResult,
} from "./browser.ts";

export { DEFAULT_MIN_PASSWORD_LENGTH } from "./index.ts";
export type {
  Credentials,
  SignInWithUsernamePasswordResult,
  SignUpWithUsernamePasswordResult,
} from "./browser.ts";

/**
 * Sign in to an existing account. Call it during component initialization.
 *
 * ```ts
 * // The <script> of the sign-in form. Its fields have `id="username"` and
 * // `id="password"`, and are disabled while `login.pending` is true.
 * import { useSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const login = useSignInWithUsernamePassword(api.auth);
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
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInWithUsernamePassword(api: {
  signInWithUsernamePassword: SignInWithUsernamePasswordMutation;
}): {
  /** Sign in with the credentials. Resolves to a result, never rejects. */
  signIn: (
    credentials: Credentials,
  ) => Promise<SignInWithUsernamePasswordResult>;
  /** `true` while the credentials are being validated. */
  readonly pending: boolean;
} {
  const { authClient, signInApi } = getConvexAuthContext(
    "useSignInWithUsernamePassword()",
  );
  const client = createSignInWithUsernamePassword({
    authClient,
    signInApi,
    api,
  });
  const pending = fromReadableStore(client.pending);
  return {
    signIn: client.signIn,
    get pending() {
      return pending.current;
    },
  };
}

/**
 * Create an account and sign in to it. Call it during component
 * initialization. Same shape as {@link useSignInWithUsernamePassword}.
 *
 * ```ts
 * const registration = useSignUpWithUsernamePassword(api.auth);
 *
 * async function onSubmit(username: string, password: string) {
 *   const result = await registration.signUp({ username, password });
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignUpWithUsernamePassword(api: {
  signUpWithUsernamePassword: SignUpWithUsernamePasswordMutation;
}): {
  /** Sign up with the credentials. Resolves to a result, never rejects. */
  signUp: (
    credentials: Credentials,
  ) => Promise<SignUpWithUsernamePasswordResult>;
  /** `true` while the credentials are being validated. */
  readonly pending: boolean;
} {
  const { authClient, signInApi } = getConvexAuthContext(
    "useSignUpWithUsernamePassword()",
  );
  const client = createSignUpWithUsernamePassword({
    authClient,
    signInApi,
    api,
  });
  const pending = fromReadableStore(client.pending);
  return {
    signUp: client.signUp,
    get pending() {
      return pending.current;
    },
  };
}
