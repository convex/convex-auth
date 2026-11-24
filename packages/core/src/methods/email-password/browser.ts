/**
 * Framework-agnostic client for the `emailPassword` method, exported at
 * `@convex-dev/auth/methods/email-password/browser`. The React hooks of
 * `@convex-dev/auth/methods/email-password/react` wrap it, and a binding for
 * another framework can too.
 *
 * Each factory makes the client of one flow, to be made once per component
 * instance. The functions resolve to results with a `userError` and never
 * reject (except when called out of order): a thrown error comes back as
 * `OTHER_ERROR`. The state of a client is a {@link ReadableStore}. A client
 * reads its options when it uses them, so a binding can pass getters, for
 * example for an `emailCode` that comes from the page's props.
 *
 * Sign-up, password recovery and email change finish with a link from an
 * email. The flow keeps a secret in `authClient.methodStorage` of the browser
 * that started it, and the link only works in that browser. The clients of
 * the landing pages of the links have a `start` function: call it when the
 * page mounts, and call the function it returns when the page unmounts.
 *
 * ```ts
 * import type { AuthClient, AuthSignInApi } from "@convex-dev/auth/browser";
 * import { createCompleteSignUpWithEmailPassword } from "@convex-dev/auth/methods/email-password/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 * declare const signInApi: AuthSignInApi;
 *
 * // The landing page of the validation link.
 * const flow = createCompleteSignUpWithEmailPassword({
 *   authClient,
 *   signInApi,
 *   api: api.auth,
 *   emailCode: new URL(window.location.href).searchParams.get("code") ?? "",
 * });
 * flow.state.subscribe(() => {
 *   const state = flow.state.get();
 *   // render state.status: "loading", "complete", or "error"
 * });
 * // On mount. The returned function is the cleanup, for the unmount.
 * const stop = flow.start();
 * ```
 *
 * @module
 */

import type { FunctionReference } from "convex/server";
import type {
  AuthSignInApi,
  ConvexMutationApi,
} from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import {
  runSignInMutation,
  type SignInUnexpectedFailure,
} from "../../browser/signInMutation.ts";
import {
  createPendingTracker,
  createStore,
  type ReadableStore,
} from "../../browser/store.ts";
import {
  createLinkFlow,
  createStartFlow,
  startOnceLoaded,
  type LinkFlowClient,
  type LinkFlowState,
  type MissingSecretError,
  type UnexpectedFailure,
  type WithoutSecret,
  type OtherError,
} from "../../browser/linkFlow.ts";
import type { ClientView } from "../../lib/types.ts";
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

export type { ReadableStore } from "../../browser/store.ts";
export type { LinkFlowClient, LinkFlowState } from "../../browser/linkFlow.ts";
export type { CheckPasswordRecoveryQueryResult as CheckPasswordRecoveryResult };

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

/** The app's `signUpWithEmailPassword` mutation. */
export type SignUpMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignUpMutationResult>
>;

/** The app's `completeSignUpWithEmailPassword` mutation. */
export type CompleteSignUpMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  ClientView<CompleteSignUpResult>
>;

/** The app's `signInWithEmailPassword` mutation. */
export type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignInMutationResult>
>;

/** The app's `startChangeEmail` mutation. */
export type StartChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { newEmail: string; currentPassword: string },
  StartChangeEmailMutationResult
>;

/** The app's `completeChangeEmail` mutation. */
export type CompleteChangeEmailMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string },
  CompleteChangeEmailResult
>;

/** The app's `startPasswordRecovery` mutation. */
export type StartPasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { email: string },
  StartPasswordRecoveryMutationResult
>;

/** The app's `checkPasswordRecovery` query. */
export type CheckPasswordRecoveryQuery = FunctionReference<
  "query",
  "public",
  { emailCode: string; browserSecret: string },
  CheckPasswordRecoveryQueryResult
>;

/** The app's `completePasswordRecovery` mutation. */
export type CompletePasswordRecoveryMutation = FunctionReference<
  "mutation",
  "public",
  { emailCode: string; browserSecret: string; newPassword: string },
  ClientView<CompletePasswordRecoveryMutationResult>
>;

/**
 * The functions that the landing page of a password-reset link calls. The
 * app's `api.auth` has both of them.
 */
export type PasswordRecoveryApi = {
  checkPasswordRecovery: CheckPasswordRecoveryQuery;
  completePasswordRecovery: CompletePasswordRecoveryMutation;
};

/** The result of `signIn` from {@link createSignInWithEmailPassword}. */
export type SignInResult =
  ClientView<SignInMutationResult> | SignInUnexpectedFailure;

/** The result of `signUp` from {@link createSignUpWithEmailPassword}. */
export type SignUpResult =
  WithoutSecret<ClientView<SignUpMutationResult>> | UnexpectedFailure;

/** The result of `startChangeEmail` from {@link createStartChangeEmail}. */
export type StartChangeEmailResult =
  WithoutSecret<StartChangeEmailMutationResult> | UnexpectedFailure;

/**
 * The result of `startPasswordRecovery` from
 * {@link createStartPasswordRecovery}.
 */
export type StartPasswordRecoveryResult =
  WithoutSecret<StartPasswordRecoveryMutationResult> | UnexpectedFailure;

/**
 * The result of `completePasswordRecovery` from
 * {@link createCompletePasswordRecovery}.
 */
export type CompletePasswordRecoveryResult =
  ClientView<CompletePasswordRecoveryMutationResult> | SignInUnexpectedFailure;

/** The state of {@link createCompleteSignUpWithEmailPassword}. */
export type CompleteSignUpState = LinkFlowState<
  | SignInError<ClientView<CompleteSignUpResult>>
  | MissingSecretError
  | OtherError
>;

/** The state of {@link createCompleteChangeEmail}. */
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
 * The state of the landing page of a password-reset link. Unlike the other
 * landing pages, the flow needs input from the user (the new password) before
 * it can complete, so a `ready` state carries the function to submit it.
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

/**
 * The state of the landing page of a password-reset link when the check of
 * the link failed, for example because the backend threw. Only a binding
 * whose query returns its error, rather than throwing it, gets this state
 * from {@link CompletePasswordRecoveryClient.stateFor}.
 */
export type PasswordRecoveryCheckFailedState = {
  status: "error";
  userError: OtherError;
};

//------------------------------------------------------------------------------
// Client shapes
//------------------------------------------------------------------------------

/** The part of the `AuthClient` that the email + password clients use. */
type EmailPasswordAuthClient = Pick<
  AuthClient,
  | "setSession"
  | "withSignInPending"
  | "methodStorage"
  | "getSnapshot"
  | "subscribe"
>;

/** The client of the sign-in flow. */
export type SignInWithEmailPasswordClient = {
  /** Send up the credentials and, on success, adopt the session. */
  signIn: (credentials: {
    email: string;
    password: string;
  }) => Promise<SignInResult>;
  /** `true` while `signIn` runs. */
  pending: ReadableStore<boolean>;
};

/** The client of the sign-up flow. */
export type SignUpWithEmailPasswordClient = {
  /**
   * Start the sign-up. On success, the backend emails the validation link,
   * and the secret of the flow is kept for the landing page of the link.
   */
  signUp: (credentials: {
    email: string;
    password: string;
  }) => Promise<SignUpResult>;
  /** `true` while `signUp` runs. */
  pending: ReadableStore<boolean>;
};

/** The client of the start of a password recovery. */
export type StartPasswordRecoveryClient = {
  /**
   * Start the recovery. On success, the backend emails the link to `sentTo`,
   * and the secret of the flow is kept for the landing page of the link.
   */
  startPasswordRecovery: (args: {
    email: string;
  }) => Promise<StartPasswordRecoveryResult>;
  /** `true` while `startPasswordRecovery` runs. */
  pending: ReadableStore<boolean>;
};

/** The client of the start of an email change. */
export type StartChangeEmailClient = {
  /**
   * Start the change. On success, the backend emails the link to the new
   * address, and the secret of the flow is kept for the landing page of the
   * link.
   */
  startChangeEmail: (args: {
    newEmail: string;
    currentPassword: string;
  }) => Promise<StartChangeEmailResult>;
  /** `true` while `startChangeEmail` runs. */
  pending: ReadableStore<boolean>;
};

/** The client of the landing page of a password-reset link. */
export type CompletePasswordRecoveryClient = {
  /**
   * Read the secret of the flow, as soon as the `AuthClient` has loaded.
   * Call it when the page mounts. Returns the cleanup for the unmount.
   */
  start: () => () => void;
  /**
   * Changes whenever {@link CompletePasswordRecoveryClient.stateFor} or
   * {@link CompletePasswordRecoveryClient.checkArgs} may return something
   * new. Subscribe to it to render again.
   */
  progress: ReadableStore<PasswordRecoveryProgress>;
  /**
   * The arguments of the `checkPasswordRecovery` subscription of the page,
   * or `"skip"` while the secret is not read. The binding subscribes to the
   * query with its own Convex client: the check is reactive, so the state
   * moves to `error` on its own when the link dies while the page is open.
   */
  checkArgs: () => { emailCode: string; browserSecret: string } | "skip";
  /**
   * The state of the page for the latest result of the
   * `checkPasswordRecovery` subscription (`undefined` while it loads). A
   * binding whose query returns its error, rather than throwing it, passes
   * the error too (`undefined` when there is none).
   */
  stateFor: {
    (
      check: CheckPasswordRecoveryQueryResult | undefined,
    ): CompletePasswordRecoveryState;
    (
      check: CheckPasswordRecoveryQueryResult | undefined,
      checkError: unknown,
    ): CompletePasswordRecoveryState | PasswordRecoveryCheckFailedState;
  };
  /**
   * Set the new password and sign the user in. Throws when the secret is not
   * read yet: call it through the `ready` state of
   * {@link CompletePasswordRecoveryClient.stateFor}.
   */
  completePasswordRecovery: (args: {
    newPassword: string;
  }) => Promise<CompletePasswordRecoveryResult>;
};

/** What a password-reset page knows, short of the check of the link. */
export type PasswordRecoveryProgress = {
  /** The secret from storage: not read yet, missing, or found. */
  browserSecret: undefined | null | string;
  /**
   * The end of the flow, once `completePasswordRecovery` reaches it. It wins
   * over the check: a completed link is a dead link for the check.
   */
  outcome:
    | Extract<CompletePasswordRecoveryState, { status: "complete" | "error" }>
    | undefined;
  /** `true` while `completePasswordRecovery` runs. */
  pending: boolean;
};

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

const foldSignInError = (cause: unknown): SignInUnexpectedFailure => ({
  status: "error",
  userError: { error: "OTHER_ERROR", cause },
});

//------------------------------------------------------------------------------
// Sign-in
//------------------------------------------------------------------------------

/**
 * Make the client of the sign-in flow: run the `signInWithEmailPassword`
 * mutation and, on success, adopt the session.
 */
export function createSignInWithEmailPassword(options: {
  /** The client the session goes to. */
  authClient: Pick<AuthClient, "setSession">;
  /** Runs the mutation, which mints a session. */
  signInApi: AuthSignInApi;
  /** The functions of the method, usually `api.auth`. */
  api: { signInWithEmailPassword: SignInMutation };
}): SignInWithEmailPasswordClient {
  const { pending, track } = createPendingTracker();
  const signIn = (credentials: {
    email: string;
    password: string;
  }): Promise<SignInResult> =>
    track(() =>
      runSignInMutation(
        options,
        options.api.signInWithEmailPassword,
        credentials,
      ),
    );
  return { signIn, pending };
}

//------------------------------------------------------------------------------
// Sign-up
//------------------------------------------------------------------------------

/**
 * Make the client of the sign-up flow: run the `signUpWithEmailPassword`
 * mutation and keep the returned secret for
 * {@link createCompleteSignUpWithEmailPassword}.
 *
 * A successful sign-up does *not* sign the user in: it sends the validation
 * email. Tell the user to open the link (in this same browser).
 */
export function createSignUpWithEmailPassword(options: {
  /** The client whose `methodStorage` keeps the secret. */
  authClient: Pick<AuthClient, "methodStorage">;
  /**
   * Runs the mutation on the Convex client of the app. Sign-up mints no
   * session, so it does not go through the `AuthSignInApi`: under SSR, that
   * API is the auth proxy, which only serves functions returning the
   * sign-in envelope.
   */
  convex: ConvexMutationApi;
  /** The functions of the method, usually `api.auth`. */
  api: { signUpWithEmailPassword: SignUpMutation };
}): SignUpWithEmailPasswordClient {
  const { run, pending } = createStartFlow(
    options,
    () => options.api.signUpWithEmailPassword,
    SECRET_STORAGE_KEYS.signUp,
  );
  return { signUp: run, pending };
}

/**
 * Make the client of the landing page of the validation link: once started,
 * it presents the code from the link with the secret stored by
 * {@link createSignUpWithEmailPassword}, and adopts the minted session.
 *
 * While the server validates the link and the client stores the new session,
 * the `AuthClient` reports `isLoading`, so the app does not see a signed-out
 * user and go to the sign-in page during this time.
 */
export function createCompleteSignUpWithEmailPassword(options: {
  /** The client the session goes to, and whose storage has the secret. */
  authClient: EmailPasswordAuthClient;
  /** Runs the mutation, which mints a session. */
  signInApi: AuthSignInApi;
  /** The functions of the method, usually `api.auth`. */
  api: { completeSignUpWithEmailPassword: CompleteSignUpMutation };
  /** The `code` query parameter of the link. */
  emailCode: string;
}): LinkFlowClient<CompleteSignUpState> {
  return createLinkFlow<SignInError<ClientView<CompleteSignUpResult>>>(
    options,
    SECRET_STORAGE_KEYS.signUp,
    (browserSecret) =>
      options.authClient.withSignInPending(async () => {
        const result = await options.signInApi.mutation(
          options.api.completeSignUpWithEmailPassword,
          { emailCode: options.emailCode, browserSecret },
        );
        if (result.status === "complete") {
          await options.authClient.setSession(result.tokens);
          return { done: true } as const;
        }
        return { done: false, userError: result.userError } as const;
      }),
  );
}

//------------------------------------------------------------------------------
// Password recovery
//------------------------------------------------------------------------------

/**
 * Make the client of the start of a password recovery: run the
 * `startPasswordRecovery` mutation and keep the returned secret for
 * {@link createCompletePasswordRecovery}. On success, `sentTo` gives the
 * address that received the link. Show this address to the user, not the
 * typed one: the two can differ in case or in Unicode form.
 */
export function createStartPasswordRecovery(options: {
  /** The client whose `methodStorage` keeps the secret. */
  authClient: Pick<AuthClient, "methodStorage">;
  /** Runs the mutation on the Convex client of the app. */
  convex: ConvexMutationApi;
  /** The functions of the method, usually `api.auth`. */
  api: { startPasswordRecovery: StartPasswordRecoveryMutation };
}): StartPasswordRecoveryClient {
  const { run, pending } = createStartFlow(
    options,
    () => options.api.startPasswordRecovery,
    SECRET_STORAGE_KEYS.passwordRecovery,
  );
  return { startPasswordRecovery: run, pending };
}

/**
 * Make the client of the landing page of the password-reset link.
 *
 * Once started, it reads the secret stored by
 * {@link createStartPasswordRecovery}. The binding then subscribes to
 * `checkPasswordRecovery` with {@link CompletePasswordRecoveryClient.checkArgs}
 * on its own Convex client, and renders
 * {@link CompletePasswordRecoveryClient.stateFor} of the latest result. When
 * the link can be used, the state is `ready`, with the function that sets the
 * new password and adopts the minted session. When the link cannot be used,
 * the state is `error`, so the page does not ask for a password.
 *
 * An error about the password keeps the state `ready`, so show it in the
 * form. An error about the link moves the state to `error`.
 */
export function createCompletePasswordRecovery(options: {
  /** The client the session goes to, and whose storage has the secret. */
  authClient: EmailPasswordAuthClient;
  /** Runs the mutation, which mints a session. */
  signInApi: AuthSignInApi;
  /** The functions of the method, usually `api.auth`. */
  api: Pick<PasswordRecoveryApi, "completePasswordRecovery">;
  /** The `code` query parameter of the link. */
  emailCode: string;
}): CompletePasswordRecoveryClient {
  const progress = createStore<PasswordRecoveryProgress>({
    browserSecret: undefined,
    outcome: undefined,
    pending: false,
  });
  const update = (patch: Partial<PasswordRecoveryProgress>) =>
    progress.set({ ...progress.get(), ...patch });
  // We count the number of pending calls out of safety, as the other flows do.
  const { pending, track } = createPendingTracker();
  pending.subscribe(() => update({ pending: pending.get() }));

  const completePasswordRecovery = ({
    newPassword,
  }: {
    newPassword: string;
  }): Promise<CompletePasswordRecoveryResult> =>
    track(async () => {
      const { browserSecret } = progress.get();
      if (typeof browserSecret !== "string") {
        // Only reachable through the `ready` state, which has the secret.
        throw new Error(
          "completePasswordRecovery was called before the flow was ready",
        );
      }
      try {
        const result = await options.signInApi.mutation(
          options.api.completePasswordRecovery,
          { emailCode: options.emailCode, browserSecret, newPassword },
        );
        if (result.status === "complete") {
          await options.authClient.setSession(result.tokens);
          await options.authClient.methodStorage.remove(
            SECRET_STORAGE_KEYS.passwordRecovery,
          );
          update({ outcome: { status: "complete" } });
        } else if (isPasswordRecoveryLinkError(result.userError)) {
          update({
            outcome: { status: "error", userError: result.userError },
          });
        }
        return result;
      } catch (cause) {
        return foldSignInError(cause);
      }
    });

  return {
    start: startOnceLoaded(options, async () => {
      const secret = await options.authClient.methodStorage.get(
        SECRET_STORAGE_KEYS.passwordRecovery,
      );
      update({ browserSecret: secret ?? null });
    }),
    progress: { get: progress.get, subscribe: progress.subscribe },
    checkArgs: () => {
      const { browserSecret } = progress.get();
      return typeof browserSecret === "string"
        ? { emailCode: options.emailCode, browserSecret }
        : "skip";
    },
    stateFor: ((
      check: CheckPasswordRecoveryQueryResult | undefined,
      checkError?: unknown,
    ): CompletePasswordRecoveryState | PasswordRecoveryCheckFailedState => {
      const { browserSecret, outcome, pending } = progress.get();
      if (outcome !== undefined) {
        return outcome;
      }
      if (browserSecret === null) {
        return { status: "error", userError: { error: "MISSING_SECRET" } };
      }
      if (checkError !== undefined) {
        return {
          status: "error",
          userError: { error: "OTHER_ERROR", cause: checkError },
        };
      }
      if (browserSecret === undefined || check === undefined) {
        return { status: "loading" };
      }
      // While `completePasswordRecovery` runs, the claim of the link reaches
      // the subscription before the mutation result reaches the page. Keep
      // the form until the result says what happened to the link.
      if (!check.success && !pending) {
        return { status: "error", userError: check.userError };
      }
      return { status: "ready", completePasswordRecovery, pending };
    }) as CompletePasswordRecoveryClient["stateFor"],
    completePasswordRecovery,
  };
}

//------------------------------------------------------------------------------
// Email change
//------------------------------------------------------------------------------

/**
 * Make the client of the start of an email change: run the `startChangeEmail`
 * mutation and keep the returned secret for {@link createCompleteChangeEmail}.
 */
export function createStartChangeEmail(options: {
  /** The client whose `methodStorage` keeps the secret. */
  authClient: Pick<AuthClient, "methodStorage">;
  /** Runs the mutation on the Convex client of the app. */
  convex: ConvexMutationApi;
  /** The functions of the method, usually `api.auth`. */
  api: { startChangeEmail: StartChangeEmailMutation };
}): StartChangeEmailClient {
  const { run, pending } = createStartFlow(
    options,
    () => options.api.startChangeEmail,
    SECRET_STORAGE_KEYS.changeEmail,
  );
  return { startChangeEmail: run, pending };
}

/**
 * Make the client of the landing page of the email-change confirmation link:
 * once started, it presents the code from the link with the secret stored by
 * {@link createStartChangeEmail}. No session is adopted: the user already has
 * one, and the backend requires it.
 */
export function createCompleteChangeEmail(options: {
  /** The client whose storage has the secret. */
  authClient: Pick<AuthClient, "methodStorage" | "getSnapshot" | "subscribe">;
  /** Runs the mutation on the Convex client of the app. */
  convex: ConvexMutationApi;
  /** The functions of the method, usually `api.auth`. */
  api: { completeChangeEmail: CompleteChangeEmailMutation };
  /** The `code` query parameter of the link. */
  emailCode: string;
}): LinkFlowClient<CompleteChangeEmailState> {
  return createLinkFlow<ExtractError<CompleteChangeEmailResult>>(
    options,
    SECRET_STORAGE_KEYS.changeEmail,
    async (browserSecret) => {
      const result = await options.convex.mutation(
        options.api.completeChangeEmail,
        { emailCode: options.emailCode, browserSecret },
      );
      if (result.success) {
        return { done: true } as const;
      }
      return { done: false, userError: result.userError } as const;
    },
  );
}
