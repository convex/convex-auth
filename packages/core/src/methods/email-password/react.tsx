/**
 * React client for the `emailPassword` method, exported at
 * `@convex-dev/auth/methods/email-password/react`.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useRef, useContext, useEffect, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { AuthClientContext, useAuth } from "../../react/client.tsx";
import { useAuthActions } from "../../react/index.tsx";
import { useAuthSignInApi } from "../../react/client.tsx";
import { useStableFunctionReference } from "../../react/functionReference.ts";
import type { NamespacedStorage } from "../../browser/storage.ts";
import type {
  SignUpResult as SignUpMutationResult,
  CompleteSignUpResult,
  SignInResult as SignInMutationResult,
  StartChangeEmailResult as StartChangeEmailMutationResult,
  CompleteChangeEmailResult,
  StartPasswordRecoveryResult as StartPasswordRecoveryMutationResult,
  CheckPasswordRecoveryResult as CheckPasswordRecoveryQueryResult,
  CompletePasswordRecoveryResult as CompletePasswordRecoveryMutationResult,
} from "./server.ts";

/**
 * The flows that the user completes with a link from an email. Each flow keeps
 * a secret in the storage of the browser that started it.
 */
type EmailLinkFlow = "signUp" | "changeEmail" | "passwordRecovery";

// One storage key per type of flow, so flows of different types can run at
// the same time. Two flows of the same type share one key: the second flow
// replaces the secret of the first.
const SECRET_STORAGE_KEYS: Record<EmailLinkFlow, string> = {
  signUp: "__convexAuthEmailPasswordSignUpSecret",
  changeEmail: "__convexAuthEmailPasswordChangeEmailSecret",
  passwordRecovery: "__convexAuthEmailPasswordRecoverySecret",
};

//------------------------------------------------------------------------------
// Result types
//------------------------------------------------------------------------------

/** The `userError` of the failure arm of a `success` envelope. */
type ExtractError<Result> = Result extends {
  success: false;
  userError: infer UserError;
}
  ? UserError
  : never;

/** The `userError` of the error arm of a sign-in envelope. */
type SignInError<Result> = Result extends {
  status: "error";
  userError: infer UserError;
}
  ? UserError
  : never;

/**
 * The mutation threw rather than resolving to a `userError`. The thrown value
 * is preserved on `cause`.
 */
type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * A link was opened in a browser that did not start the flow: the flow's
 * secret is not in this browser's storage, so completion cannot proceed. Tell
 * the user to open the link in the browser they started from.
 */
type MissingSecretError = { error: "MISSING_SECRET" };

type UnexpectedFailure = { success: false; userError: OtherError };

/**
 * The success arm of a "start" result, without the `browserSecret`. The hook
 * stores the secret itself; the caller has no use for it, and keeping it out
 * of the result keeps it out of URLs and logs.
 */
type WithoutSecret<Result> = Result extends { success: true }
  ? Omit<Result, "browserSecret">
  : Result;

type SignInUnexpectedFailure = { status: "error"; userError: OtherError };

type SignUpMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignUpMutationResult>
>;

type CompleteSignUpMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  ClientView<CompleteSignUpResult>
>;

type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignInMutationResult>
>;

type StartChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { newEmail: string; currentPassword: string },
  StartChangeEmailMutationResult
>;

type CompleteChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  CompleteChangeEmailResult
>;

type StartPasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  StartPasswordRecoveryMutationResult
>;

type CheckPasswordRecoveryQuery = FunctionReference<
  "query",
  "public",
  { emailCode: string; browserSecret: string },
  CheckPasswordRecoveryQueryResult
>;

type CompletePasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string; newPassword: string },
  ClientView<CompletePasswordRecoveryMutationResult>
>;

/**
 * The functions that {@link useCompletePasswordRecovery} calls. The app's
 * `api.auth` has both of them.
 */
export type PasswordRecoveryApi = {
  checkPasswordRecovery: CheckPasswordRecoveryQuery;
  completePasswordRecovery: CompletePasswordRecoveryMutation;
};

/** The result of the `signIn` callback from {@link useSignInWithEmailPassword}. */
export type SignInResult =
  ClientView<SignInMutationResult> | SignInUnexpectedFailure;

/** The result of the `signUp` callback from {@link useSignUpWithEmailPassword}. */
export type SignUpResult =
  WithoutSecret<ClientView<SignUpMutationResult>> | UnexpectedFailure;

/** The result of the `startChangeEmail` callback from {@link useStartChangeEmail}. */
export type StartChangeEmailResult =
  WithoutSecret<StartChangeEmailMutationResult> | UnexpectedFailure;

/** The result of the `startPasswordRecovery` callback from {@link useStartPasswordRecovery}. */
export type StartPasswordRecoveryResult =
  WithoutSecret<StartPasswordRecoveryMutationResult> | UnexpectedFailure;

/**
 * The result of the `completePasswordRecovery` callback of the `ready` state
 * of {@link useCompletePasswordRecovery}.
 */
export type CompletePasswordRecoveryResult =
  ClientView<CompletePasswordRecoveryMutationResult> | SignInUnexpectedFailure;

/**
 * The state of a landing page hook: `loading` until the link has been
 * presented, then `complete` or `error`.
 */
export type LinkFlowState<UserError> =
  | { status: "loading" }
  | { status: "complete" }
  | { status: "error"; userError: UserError };

/** The state of {@link useCompleteSignUp}. */
export type CompleteSignUpState = LinkFlowState<
  | SignInError<ClientView<CompleteSignUpResult>>
  | MissingSecretError
  | OtherError
>;

/** The state of {@link useCompleteChangeEmail}. */
export type CompleteChangeEmailState = LinkFlowState<
  ExtractError<CompleteChangeEmailResult> | MissingSecretError | OtherError
>;

/**
 * The errors about the link rather than about the new password: the errors
 * of `checkPasswordRecovery`. They end the flow: the user needs a new link.
 */
type PasswordRecoveryLinkError = ExtractError<CheckPasswordRecoveryQueryResult>;

// One key for each link error. Thus a new error in the result of
// `checkPasswordRecovery` is a compile error here.
const PASSWORD_RECOVERY_LINK_ERRORS: Record<
  PasswordRecoveryLinkError["error"],
  true
> = { INVALID_CHALLENGE: true, INCORRECT_CODE: true };

function isPasswordRecoveryLinkError(
  userError: SignInError<ClientView<CompletePasswordRecoveryMutationResult>>,
): userError is PasswordRecoveryLinkError {
  return userError.error in PASSWORD_RECOVERY_LINK_ERRORS;
}

/**
 * The state of {@link useCompletePasswordRecovery}. Unlike the other landing
 * page hooks, the flow needs input from the user (the new password) before it
 * can complete, so a `ready` state carries the function to submit it.
 */
export type CompletePasswordRecoveryState =
  | { status: "loading" }
  | {
      status: "ready";
      /**
       * Set the new password and sign the user in. Errors about the new
       * password come back in the result and leave the state `ready`, so the
       * user can try another password with the same link.
       */
      completePasswordRecovery: (args: {
        newPassword: string;
      }) => Promise<CompletePasswordRecoveryResult>;
      /** `true` while `completePasswordRecovery` is in flight. */
      pending: boolean;
    }
  | { status: "complete" }
  | {
      status: "error";
      userError: PasswordRecoveryLinkError | MissingSecretError;
    };

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

function useSecretStorage(): NamespacedStorage {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error("Must be used within a <ConvexAuthProvider>.");
  }
  return authClient.storage;
}

/**
 * The auth client's `withSignInPending`: while its call runs, the auth state
 * reports `isLoading` instead of signed out.
 */
function useWithSignInPending() {
  const authClient = useContext(AuthClientContext);
  if (authClient === undefined) {
    throw new Error("Must be used within a <ConvexAuthProvider>.");
  }
  return authClient.withSignInPending;
}

/**
 * Track the in-flight state of async calls.
 */
function usePending() {
  const [pending, setPending] = useState(false);

  // We count the number of pending calls out of safety.
  // Normally apps shouldn’t start concurrent flows (e.g. they should disable
  // form submission when a current submission is ongoing), this is just a layer
  // of extra safey in case they don’t do it correctly.
  const inFlight = useRef(0);

  const track = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(true);
    try {
      return await work();
    } finally {
      if (--inFlight.current === 0) setPending(false);
    }
  }, []);
  return { pending, track };
}

const foldError = (cause: unknown): UnexpectedFailure => ({
  success: false,
  userError: { error: "OTHER_ERROR", cause },
});

const foldSignInError = (cause: unknown): SignInUnexpectedFailure => ({
  status: "error",
  userError: { error: "OTHER_ERROR", cause },
});

/**
 * Present a link once, as soon as the page opens: wait for the auth client to
 * load, read the flow's secret, run `complete` with it, and clear the secret
 * when the flow is done. A failed completion keeps the secret: the user may
 * have opened an older link, and the newest one must still work.
 *
 * Runs on initial mount. We want for this to run on page load. This is
 * acceptable: since we use browser secrets, we don’t need an additional
 * user confirmation.
 */
function useLinkFlow<UserError>(
  flow: EmailLinkFlow,
  complete: (
    browserSecret: string,
  ) => Promise<{ done: true } | { done: false; userError: UserError }>,
): LinkFlowState<UserError | MissingSecretError | OtherError> {
  const { isLoading } = useAuth();
  const storage = useSecretStorage();
  const [state, setState] = useState<
    LinkFlowState<UserError | MissingSecretError | OtherError>
  >({ status: "loading" });

  // Make sure it’s the first useEffect run to avoid issues in React strict mode
  const started = useRef(false);

  useEffect(() => {
    if (isLoading || started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        const browserSecret = await storage.get(SECRET_STORAGE_KEYS[flow]);
        if (browserSecret === null || browserSecret === undefined) {
          setState({ status: "error", userError: { error: "MISSING_SECRET" } });
          return;
        }
        const result = await complete(browserSecret);
        if (result.done) {
          await storage.remove(SECRET_STORAGE_KEYS[flow]);
          setState({ status: "complete" });
        } else {
          setState({ status: "error", userError: result.userError });
        }
      } catch (cause) {
        setState({
          status: "error",
          userError: { error: "OTHER_ERROR", cause },
        });
      }
    })();
  }, [isLoading, storage, flow, complete]);

  return state;
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
  const signInMutation = useStableFunctionReference(
    api.signInWithEmailPassword,
  );
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const { pending, track } = usePending();

  const signIn = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignInResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(signInMutation, credentials);
          if (result.status === "complete") {
            await setSession(result.tokens);
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [signInApi, signInMutation, setSession, track],
  );

  return { signIn, pending };
}

//------------------------------------------------------------------------------
// Sign-up
//------------------------------------------------------------------------------

/**
 * Client for the sign-up flow: run the `signUpWithEmailPassword` mutation and keep
 * the returned secret for {@link useCompleteSignUp}.
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
  const signUpMutation = api.signUpWithEmailPassword;
  // Sign-up mints no session, so it calls Convex directly rather than going
  // through the `AuthSignInApi`. Under SSR, that API is the auth proxy, which
  // only serves functions returning the sign-in envelope.
  const runSignUp = useMutation(signUpMutation);
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const signUp = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignUpResult> =>
      track(async () => {
        try {
          const result = await runSignUp(credentials);
          if (result.success) {
            await storage.set(SECRET_STORAGE_KEYS.signUp, result.browserSecret);
            return { success: true };
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [runSignUp, storage, track],
  );

  return { signUp, pending };
}

/**
 * Client for the landing page of the validation link: as soon as the page
 * opens, present the code from the link with the secret stored by
 * {@link useSignUpWithEmailPassword}, and adopt the minted session.
 *
 * ```tsx
 * function ValidateEmail({ emailCode }: { emailCode: string }) {
 *   const state = useCompleteSignUp(api.auth, { emailCode });
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
export function useCompleteSignUp(
  api: { completeSignUp: CompleteSignUpMutation },
  { emailCode }: { emailCode: string },
): CompleteSignUpState {
  const completeSignUpMutation = useStableFunctionReference(api.completeSignUp);
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const withSignInPending = useWithSignInPending();

  // Keep `isLoading` true while the server validates the link and the client
  // stores the new session, so the app does not see a signed-out user and
  // go to the sign-in page during this time.
  const complete = useCallback(
    (browserSecret: string) =>
      withSignInPending(async () => {
        const result = await signInApi.mutation(completeSignUpMutation, {
          emailCode,
          browserSecret,
        });
        if (result.status === "complete") {
          await setSession(result.tokens);
          return { done: true } as const;
        }
        return { done: false, userError: result.userError } as const;
      }),
    [
      signInApi,
      completeSignUpMutation,
      emailCode,
      setSession,
      withSignInPending,
    ],
  );

  return useLinkFlow<SignInError<ClientView<CompleteSignUpResult>>>(
    "signUp",
    complete,
  );
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
  const startPasswordRecoveryMutation = api.startPasswordRecovery;
  const runStartPasswordRecovery = useMutation(startPasswordRecoveryMutation);
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const startPasswordRecovery = useCallback(
    async (args: { email: string }): Promise<StartPasswordRecoveryResult> =>
      track(async () => {
        try {
          const result = await runStartPasswordRecovery(args);
          if (result.success) {
            await storage.set(
              SECRET_STORAGE_KEYS.passwordRecovery,
              result.browserSecret,
            );
            return { success: true, sentTo: result.sentTo };
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [runStartPasswordRecovery, storage, track],
  );

  return { startPasswordRecovery, pending };
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
  const { checkPasswordRecovery } = recoveryApi;
  const completeMutation = useStableFunctionReference(
    recoveryApi.completePasswordRecovery,
  );
  const { isLoading } = useAuth();
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const storage = useSecretStorage();
  const { pending, track } = usePending();
  // The secret from storage: not read yet, missing, or found.
  const [browserSecret, setBrowserSecret] = useState<undefined | null | string>(
    undefined,
  );
  // The end of the flow, once `completePasswordRecovery` reaches it. It
  // wins over the check: a completed link is a dead link for the check.
  const [outcome, setOutcome] =
    useState<
      Extract<CompletePasswordRecoveryState, { status: "complete" | "error" }>
    >();

  useEffect(() => {
    if (isLoading) {
      return;
    }
    void (async () => {
      const secret = await storage.get(SECRET_STORAGE_KEYS.passwordRecovery);
      setBrowserSecret(secret ?? null);
    })();
  }, [isLoading, storage]);

  const check = useQuery(
    checkPasswordRecovery,
    typeof browserSecret === "string" ? { emailCode, browserSecret } : "skip",
  );

  const completePasswordRecovery = useCallback(
    async ({
      newPassword,
    }: {
      newPassword: string;
    }): Promise<CompletePasswordRecoveryResult> =>
      track(async () => {
        if (typeof browserSecret !== "string") {
          // Only reachable through the `ready` state, which has the secret.
          throw new Error(
            "completePasswordRecovery was called before the flow was ready",
          );
        }
        try {
          const result = await signInApi.mutation(completeMutation, {
            emailCode,
            browserSecret,
            newPassword,
          });
          if (result.status === "complete") {
            await setSession(result.tokens);
            await storage.remove(SECRET_STORAGE_KEYS.passwordRecovery);
            setOutcome({ status: "complete" });
          } else if (isPasswordRecoveryLinkError(result.userError)) {
            setOutcome({ status: "error", userError: result.userError });
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [
      signInApi,
      completeMutation,
      emailCode,
      browserSecret,
      storage,
      setSession,
      track,
    ],
  );

  if (outcome !== undefined) {
    return outcome;
  }
  if (browserSecret === null) {
    return { status: "error", userError: { error: "MISSING_SECRET" } };
  }
  if (browserSecret === undefined || check === undefined) {
    return { status: "loading" };
  }
  // While `completePasswordRecovery` runs, the claim of the link reaches
  // the subscription before the mutation result reaches the page. Keep the
  // form until the result says what happened to the link.
  if (!check.success && !pending) {
    return { status: "error", userError: check.userError };
  }
  return { status: "ready", completePasswordRecovery, pending };
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
  const startChangeEmailMutation = api.startChangeEmail;
  const runStartChangeEmail = useMutation(startChangeEmailMutation);
  const storage = useSecretStorage();
  const { pending, track } = usePending();

  const startChangeEmail = useCallback(
    async (args: {
      newEmail: string;
      currentPassword: string;
    }): Promise<StartChangeEmailResult> =>
      track(async () => {
        try {
          const result = await runStartChangeEmail(args);
          if (result.success) {
            await storage.set(
              SECRET_STORAGE_KEYS.changeEmail,
              result.browserSecret,
            );
            return { success: true };
          }
          return result;
        } catch (cause) {
          return foldError(cause);
        }
      }),
    [runStartChangeEmail, storage, track],
  );

  return { startChangeEmail, pending };
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
  const completeChangeEmailMutation = api.completeChangeEmail;
  const runCompleteChangeEmail = useMutation(completeChangeEmailMutation);

  const complete = useCallback(
    async (browserSecret: string) => {
      const result = await runCompleteChangeEmail({ emailCode, browserSecret });
      if (result.success) {
        return { done: true } as const;
      }
      return { done: false, userError: result.userError } as const;
    },
    [runCompleteChangeEmail, emailCode],
  );

  return useLinkFlow<ExtractError<CompleteChangeEmailResult>>(
    "changeEmail",
    complete,
  );
}
