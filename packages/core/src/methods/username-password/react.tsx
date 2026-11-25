/**
 * React client for the `usernamePassword` method, exported at
 * `@convex-dev/auth/methods/username-password/react`.
 *
 * A method's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession` (see {@link
 * useAuthActions}).
 *
 * The `usernamePassword` method has two flows and provides a hook for each:
 *  1. signing in to an existing account ({@link useSignInWithUsernamePassword})
 *  2. signing up a new one ({@link useSignUpWithUsernamePassword})
 *
 * Each hook returns a function for sending up the credentials and a `pending`
 * value that is flipped to `true` while the credentials are being validated.
 *
 * The hooks wrap the framework-agnostic clients of
 * `@convex-dev/auth/methods/username-password/browser`.
 *
 * @module
 */
"use client";

import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useMethodClient, useReadableStore } from "../../react/store.ts";
import {
  createSignInWithUsernamePassword,
  createSignUpWithUsernamePassword,
  type SignInWithUsernamePasswordMutation,
  type SignUpWithUsernamePasswordMutation,
} from "./browser.ts";

export type {
  Credentials,
  SignInWithUsernamePasswordResult,
  SignUpWithUsernamePasswordResult,
} from "./browser.ts";

/**
 * Client for the sign-in flow of the `usernamePassword` method: wire the backend's
 * `signInWithUsernamePassword` mutation to the core client.
 *
 * The returned `signIn` runs the mutation with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signIn`, check the `status` field on the return value to see
 * whether the sign-in was successful or if you need to handle an error.
 *
 * ```tsx
 * import { useSignInWithUsernamePassword } from "@convex-dev/auth/methods/username-password/react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithUsernamePassword(api.auth);
 *   const [username, setUsername] = useState("");
 *   const [password, setPassword] = useState("");
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ username, password });
 *         if (result.status !== "complete") {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       <label htmlFor="username">
 *         Username
 *         <input
 *           // A static id helps password managers
 *           id="username"
 *           name="username"
 *           type="text"
 *           value={username}
 *           onChange={(e) => setUsername(e.target.value)}
 *           autoComplete="username"
 *           required
 *           disabled={pending}
 *         />
 *       </label>
 *       <label htmlFor="password">
 *         Password
 *         <input
 *           // A static id helps password managers
 *           id="password"
 *           name="password"
 *           type="password"
 *           value={password}
 *           onChange={(e) => setPassword(e.target.value)}
 *           autoComplete="current-password"
 *           required
 *           disabled={pending}
 *         />
 *       </label>
 *       <button type="submit" disabled={pending}>
 *         Log in
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignInWithUsernamePassword(api: {
  signInWithUsernamePassword: SignInWithUsernamePasswordMutation;
}) {
  const { setSession } = useAuthActions();
  // Running through the signInApi rather than `useMutation` is what lets these
  // hooks serve both session models. See {@link useAuthSignInApi}.
  const signInApi = useAuthSignInApi();
  // One client per hook instance, so each form keeps its own `pending`.
  const client = useMethodClient(createSignInWithUsernamePassword, {
    authClient: { setSession },
    signInApi,
    api,
  });
  const pending = useReadableStore(client.pending);
  return {
    /**
     * Passes up the given credentials to perform a username/password sign in.
     *
     * Returns an object with a `status` field.
     *
     * If it is `"complete"` the sign-in was successful and the client will
     * establish an authenticated session with the Convex backend server.
     *
     * If it is `"error"` the returned object will have a `userError` field with
     * additional details about why sign-in failed.
     */
    signIn: client.signIn,
    /** `true` if the sign-in attempt is being validated. */
    pending,
  };
}

/**
 * Client for the sign-up flow of the `usernamePassword` method: wire the backend's
 * `signUpWithUsernamePassword` mutation to the core client.
 *
 * The returned `signUp` runs the mutation with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signUp`, check the `status` field on the return value to see
 * whether the sign-up was successful or if you need to handle an error.
 *
 * ```tsx
 * import { useSignUpWithUsernamePassword } from "@convex-dev/auth/methods/username-password/react";
 * import { api } from "../convex/_generated/api";
 *
 * function SignUp() {
 *   const { signUp, pending } = useSignUpWithUsernamePassword(api.auth);
 *   // ...same shape as useSignInWithUsernamePassword
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignUpWithUsernamePassword(api: {
  signUpWithUsernamePassword: SignUpWithUsernamePasswordMutation;
}) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const client = useMethodClient(createSignUpWithUsernamePassword, {
    authClient: { setSession },
    signInApi,
    api,
  });
  const pending = useReadableStore(client.pending);
  return {
    /**
     * Passes up the given credentials to perform a username/password sign up.
     *
     * Returns an object with a `status` field.
     *
     * If it is `"complete"` the sign-up was successful and the client will
     * establish an authenticated session with the Convex backend server.
     *
     * If it is `"error"` the returned object will have a `userError` field with
     * additional details about why sign-up failed.
     */
    signUp: client.signUp,
    /** `true` if the sign-up attempt is being validated. */
    pending,
  };
}
