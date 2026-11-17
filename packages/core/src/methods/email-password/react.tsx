/**
 * React client for the `emailPassword` method, exported at
 * `@convex-dev/auth/methods/email-password/react`.
 *
 * The hooks wrap the framework-agnostic clients of
 * `@convex-dev/auth/methods/email-password/browser`.
 *
 * @module
 */
"use client";

import { useConvex, useQuery } from "convex/react";
import { useEffect, useMemo } from "react";
import type { ConvexMutationApi } from "../../browser/ambientSignInClient.ts";
import {
  useAuth,
  useAuthClient,
  useAuthSignInApi,
} from "../../react/client.tsx";
import { useAuthActions } from "../../react/index.tsx";
import { useMethodClient, useReadableStore } from "../../react/store.ts";
import {
  createCompleteChangeEmail,
  createCompletePasswordRecovery,
  createCompleteSignUpWithEmailPassword,
  createSignInWithEmailPassword,
  createSignUpWithEmailPassword,
  createStartChangeEmail,
  createStartPasswordRecovery,
  type CompleteChangeEmailMutation,
  type CompleteChangeEmailState,
  type CompletePasswordRecoveryState,
  type CompleteSignUpMutation,
  type CompleteSignUpState,
  type PasswordRecoveryApi,
  type SignInMutation,
  type SignUpMutation,
  type StartChangeEmailMutation,
  type StartPasswordRecoveryMutation,
} from "./browser.ts";

export type {
  CompleteChangeEmailState,
  CompletePasswordRecoveryResult,
  CompletePasswordRecoveryState,
  CompleteSignUpState,
  LinkFlowState,
  PasswordRecoveryApi,
  SignInResult,
  SignUpResult,
  StartChangeEmailResult,
  StartPasswordRecoveryResult,
} from "./browser.ts";

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

/** The auth client of the surrounding provider. */
function useConvexMutations(): ConvexMutationApi {
  const convex = useConvex();
  if (convex === undefined) {
    throw new Error(
      "Could not find Convex client! `useMutation` must be used in the React " +
        "component tree under `ConvexProvider`. Did you forget it? See " +
        "https://docs.convex.dev/quick-start#set-up-convex-in-your-react-app",
    );
  }
  return useMemo(
    () => ({ mutation: (fn, args) => convex.mutation(fn, args) }),
    [convex],
  );
}

//------------------------------------------------------------------------------
// Sign-in
//------------------------------------------------------------------------------

/**
 * Client for the sign-in flow: run the `signInWithEmailPassword` mutation and, on
 * success, establish an authenticated session.
 *
 * ```tsx
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithEmailPassword(api.auth);
 *   const [email, setEmail] = useState("");
 *   const [password, setPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ email, password });
 *         // map result.userError (INVALID_CREDENTIALS, …) to a message
 *         setError(result.status === "error" ? result.userError.error : null);
 *       }}
 *     >
 *       <label>
 *         Email
 *         <input
 *           type="email"
 *           autoComplete="username"
 *           required
 *           value={email}
 *           onChange={(e) => setEmail(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       <label>
 *         Password
 *         <input
 *           type="password"
 *           autoComplete="current-password"
 *           required
 *           value={password}
 *           onChange={(e) => setPassword(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
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
export function useSignInWithEmailPassword(api: {
  signInWithEmailPassword: SignInMutation;
}) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  // One client per hook instance, so each form keeps its own `pending`.
  const client = useMethodClient(createSignInWithEmailPassword, {
    authClient: { setSession },
    signInApi,
    api,
  });
  const pending = useReadableStore(client.pending);
  return { signIn: client.signIn, pending };
}

//------------------------------------------------------------------------------
// Sign-up
//------------------------------------------------------------------------------

/**
 * Client for the sign-up flow: run the `signUpWithEmailPassword` mutation and keep
 * the returned secret for {@link useCompleteSignUpWithEmailPassword}.
 *
 * A successful sign-up does *not* sign the user in: it sends the validation
 * email. Tell the user to open the link (in this same browser).
 *
 * ```tsx
 * function SignUp() {
 *   const { signUp, pending } = useSignUpWithEmailPassword(api.auth);
 *   const [email, setEmail] = useState("");
 *   const [password, setPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *   const [sentTo, setSentTo] = useState<string | null>(null);
 *
 *   if (sentTo !== null) {
 *     return <p>We sent a link to {sentTo}. Open it in this browser.</p>;
 *   }
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signUp({ email, password });
 *         if (result.success) {
 *           setSentTo(email);
 *         } else {
 *           // map result.userError (EMAIL_TAKEN, PASSWORD_TOO_SHORT, …) to a message
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <label>
 *         Email
 *         <input
 *           type="email"
 *           autoComplete="username"
 *           required
 *           value={email}
 *           onChange={(e) => setEmail(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       <label>
 *         Password
 *         <input
 *           type="password"
 *           autoComplete="new-password"
 *           required
 *           value={password}
 *           onChange={(e) => setPassword(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={pending}>
 *         Create account
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useSignUpWithEmailPassword(api: {
  signUpWithEmailPassword: SignUpMutation;
}) {
  // Sign-up mints no session, so it calls Convex directly rather than going
  // through the `AuthSignInApi`. Under SSR, that API is the auth proxy, which
  // only serves functions returning the sign-in envelope.
  const convex = useConvexMutations();
  const authClient = useAuthClient();
  const client = useMethodClient(createSignUpWithEmailPassword, {
    authClient,
    convex,
    api,
  });
  const pending = useReadableStore(client.pending);
  return { signUp: client.signUp, pending };
}

/**
 * Client for the landing page of the validation link: as soon as the page
 * opens, present the code from the link with the secret stored by
 * {@link useSignUpWithEmailPassword}, and adopt the minted session.
 *
 * ```tsx
 * function ValidateEmail({ emailCode }: { emailCode: string }) {
 *   const state = useCompleteSignUpWithEmailPassword(api.auth, { emailCode });
 *   switch (state.status) {
 *     case "loading": // validating…
 *     case "complete": // signed in
 *     case "error": // map state.userError to a message
 *   }
 * }
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompleteSignUpWithEmailPassword(
  api: { completeSignUpWithEmailPassword: CompleteSignUpMutation },
  { emailCode }: { emailCode: string },
): CompleteSignUpState {
  // Outside a provider, throw the error this hook has always thrown.
  useAuthActions();
  const authClient = useAuthClient();
  const signInApi = useAuthSignInApi();
  const client = useMethodClient(createCompleteSignUpWithEmailPassword, {
    authClient,
    signInApi,
    api,
    emailCode,
  });
  // Presents the link once, on page load. In StrictMode the cleanup of the
  // first run only cancels a start that still waits for the auth client.
  useEffect(() => client.start(), [client]);
  return useReadableStore(client.state);
}

//------------------------------------------------------------------------------
// Password recovery
//------------------------------------------------------------------------------

/**
 * Client for starting a password recovery: run the backend's
 * `startPasswordRecovery` mutation and keep the returned secret for
 * {@link useCompletePasswordRecovery}. On success, `sentTo` gives the address
 * that received the link. Show this address to the user, not the typed one:
 * the two can differ in case or in Unicode form.
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useStartPasswordRecovery(api: {
  startPasswordRecovery: StartPasswordRecoveryMutation;
}) {
  const convex = useConvexMutations();
  const authClient = useAuthClient();
  const client = useMethodClient(createStartPasswordRecovery, {
    authClient,
    convex,
    api,
  });
  const pending = useReadableStore(client.pending);
  return { startPasswordRecovery: client.startPasswordRecovery, pending };
}

/**
 * Client for the landing page of the password-reset link. As soon as the page
 * opens, it reads the secret stored by {@link useStartPasswordRecovery} and
 * subscribes to `checkPasswordRecovery` with it and the code from the link.
 * When the link can be used, the state is `ready`, with the function that
 * sets the new password and adopts the minted session. When the link cannot
 * be used, the state is `error`, so the page does not ask for a password.
 *
 * The check is a subscription, thus the state moves to `error` on its own
 * when the link dies while the page is open: another tab claims it, or it
 * expires and the server erases it.
 *
 * The hook does not complete the flow by itself: the flow needs the new
 * password, so call `completePasswordRecovery` when the user submits the
 * form. An error about the password keeps the state `ready`, so show it in
 * the form. An error about the link moves the state to `error`.
 *
 * ```tsx
 * function ResetPassword({ emailCode }: { emailCode: string }) {
 *   const state = useCompletePasswordRecovery(api.auth, { emailCode });
 *   const [newPassword, setNewPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   switch (state.status) {
 *     case "loading":
 *       return <p>Checking the link…</p>;
 *     case "complete":
 *       return <Navigate to="/" replace />;
 *     case "error":
 *       // map state.userError (MISSING_SECRET, INVALID_CHALLENGE, …) to a message
 *       return <p role="alert">This link cannot be used.</p>;
 *   }
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await state.completePasswordRecovery({ newPassword });
 *         // map result.userError (PASSWORD_TOO_SHORT, …) to a message
 *         setError(result.status === "error" ? result.userError.error : null);
 *       }}
 *     >
 *       <label>
 *         New password
 *         <input
 *           type="password"
 *           autoComplete="new-password"
 *           required
 *           value={newPassword}
 *           onChange={(e) => setNewPassword(e.target.value)}
 *           disabled={state.pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={state.pending}>
 *         Reset password and sign in
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param recoveryApi The app's `checkPasswordRecovery` query and
 * `completePasswordRecovery` mutation references, for example `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompletePasswordRecovery(
  recoveryApi: PasswordRecoveryApi,
  { emailCode }: { emailCode: string },
): CompletePasswordRecoveryState {
  // Outside a provider, throw the error this hook has always thrown.
  useAuth();
  const authClient = useAuthClient();
  const signInApi = useAuthSignInApi();
  const client = useMethodClient(createCompletePasswordRecovery, {
    authClient,
    signInApi,
    api: recoveryApi,
    emailCode,
  });
  useEffect(() => client.start(), [client]);
  // Render again when the secret is read, or the completion moves on.
  useReadableStore(client.progress);
  // The client reads the options of the last committed render, so take the
  // code of this render: the subscription must follow a new code right away.
  const args = client.checkArgs();
  const check = useQuery(
    recoveryApi.checkPasswordRecovery,
    args === "skip" ? args : { ...args, emailCode },
  );
  return client.stateFor(check);
}

//------------------------------------------------------------------------------
// Email change
//------------------------------------------------------------------------------

/**
 * Client for starting an email change: run the backend's `startChangeEmail`
 * mutation and keep the returned secret for {@link useCompleteChangeEmail}.
 *
 * @param api The functions of the method, usually `api.auth`.
 */
export function useStartChangeEmail(api: {
  startChangeEmail: StartChangeEmailMutation;
}) {
  const convex = useConvexMutations();
  const authClient = useAuthClient();
  const client = useMethodClient(createStartChangeEmail, {
    authClient,
    convex,
    api,
  });
  const pending = useReadableStore(client.pending);
  return { startChangeEmail: client.startChangeEmail, pending };
}

/**
 * Client for the landing page of the email-change confirmation link: as soon
 * as the page opens, present the code from the link with the secret stored by
 * {@link useStartChangeEmail}. No session is adopted: the user already has
 * one, and the backend requires it.
 *
 * @param api The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompleteChangeEmail(
  api: { completeChangeEmail: CompleteChangeEmailMutation },
  { emailCode }: { emailCode: string },
): CompleteChangeEmailState {
  const convex = useConvexMutations();
  // Outside a provider, throw the error this hook has always thrown.
  useAuth();
  const authClient = useAuthClient();
  const client = useMethodClient(createCompleteChangeEmail, {
    authClient,
    convex,
    api,
    emailCode,
  });
  useEffect(() => client.start(), [client]);
  return useReadableStore(client.state);
}
