/**
 * Svelte client for the `emailPassword` method, exported at
 * `@convex-dev/auth/methods/email-password/svelte`: the counterpart of
 * `@convex-dev/auth/methods/email-password/react`.
 *
 * Sign-up, password recovery and email change finish with a link from an
 * email. The flow keeps a secret in the storage of the browser that started
 * it, and the link only works in that browser.
 *
 * Call every helper during component initialization. Read `pending` and
 * `current` from the returned objects (don't destructure them), so they stay
 * reactive. The helpers of the landing pages of the links return
 * `{ current }`, where the React hooks return the state itself.
 *
 * The helpers wrap the framework-agnostic clients of
 * `@convex-dev/auth/methods/email-password/browser`.
 *
 * @module
 */

import { onMount } from "svelte";
import { useQuery } from "convex-svelte";
import { getConvexAuthContext } from "../../svelte/client.svelte.ts";
import { selectStore } from "../../browser/store.ts";
import {
  fromReadableStore,
  landingPage,
  pendingOf,
} from "../../svelte/store.ts";

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
  type CompletePasswordRecoveryState as LinkCheckedState,
  type CompleteSignUpMutation,
  type CompleteSignUpState,
  type PasswordRecoveryApi,
  type PasswordRecoveryCheckFailedState,
  type SignInMutation,
  type SignInResult,
  type SignUpMutation,
  type SignUpResult,
  type StartChangeEmailMutation,
  type StartChangeEmailResult,
  type StartPasswordRecoveryMutation,
  type StartPasswordRecoveryResult,
} from "./browser.ts";

export { DEFAULT_MIN_PASSWORD_LENGTH } from "./index.ts";
export type {
  CompleteChangeEmailState,
  CompletePasswordRecoveryResult,
  CompleteSignUpState,
  LinkFlowState,
  PasswordRecoveryApi,
  SignInResult,
  SignUpResult,
  StartChangeEmailResult,
  StartPasswordRecoveryResult,
} from "./browser.ts";

/**
 * The state of the landing page of a password-reset link. Unlike the state
 * of the React hook, it can be `OTHER_ERROR` when the check of the link
 * failed, because `useQuery` of `convex-svelte` returns the error rather than
 * throwing it.
 */
export type CompletePasswordRecoveryState =
  LinkCheckedState | PasswordRecoveryCheckFailedState;

//------------------------------------------------------------------------------
// Sign-in
//------------------------------------------------------------------------------

/**
 * Sign in with an email and a password. Call it during component
 * initialization.
 *
 * ```ts
 * import { useSignInWithEmailPassword } from "@convex-dev/auth/methods/email-password/svelte";
 * import { api } from "../convex/_generated/api";
 *
 * const login = useSignInWithEmailPassword(api.auth);
 *
 * async function onSubmit(email: string, password: string) {
 *   const result = await login.signIn({ email, password });
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 */
export function useSignInWithEmailPassword(api: {
  signInWithEmailPassword: SignInMutation;
}): {
  /** Sign in. Resolves to a result, never rejects. */
  signIn: (credentials: {
    email: string;
    password: string;
  }) => Promise<SignInResult>;
  /** `true` while the credentials are being validated. */
  readonly pending: boolean;
} {
  const { authClient, signInApi } = getConvexAuthContext(
    "useSignInWithEmailPassword()",
  );
  const client = createSignInWithEmailPassword({ authClient, signInApi, api });
  return Object.assign(pendingOf(client.pending), { signIn: client.signIn });
}

//------------------------------------------------------------------------------
// Sign-up
//------------------------------------------------------------------------------

/**
 * Start a sign-up. On success, the backend emails a link to the address, and
 * the page that the link opens calls
 * {@link useCompleteSignUpWithEmailPassword}.
 *
 * ```ts
 * const registration = useSignUpWithEmailPassword(api.auth);
 *
 * async function onSubmit(email: string, password: string) {
 *   const result = await registration.signUp({ email, password });
 *   if (result.success) {
 *     // Tell the user to open the link in this browser.
 *   }
 * }
 * ```
 */
export function useSignUpWithEmailPassword(api: {
  signUpWithEmailPassword: SignUpMutation;
}): {
  /** Start the sign-up. Resolves to a result, never rejects. */
  signUp: (credentials: {
    email: string;
    password: string;
  }) => Promise<SignUpResult>;
  /** `true` while the sign-up is being started. */
  readonly pending: boolean;
} {
  const { authClient, convex } = getConvexAuthContext(
    "useSignUpWithEmailPassword()",
  );
  const client = createSignUpWithEmailPassword({ authClient, convex, api });
  return Object.assign(pendingOf(client.pending), { signUp: client.signUp });
}

/**
 * Finish a sign-up from the link in the email, which signs the user in. It
 * runs on its own once the session has loaded: render from `current`.
 *
 * ```ts
 * // The <script> of the page of the link. In SvelteKit, the code comes from
 * // `page.url.searchParams` of `$app/state`.
 * const emailCode = new URL(location.href).searchParams.get("code") ?? "";
 * const signUp = useCompleteSignUpWithEmailPassword(api.auth, { emailCode });
 * // In the template: {#if signUp.current.status === "complete"}…{/if}
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompleteSignUpWithEmailPassword(
  api: { completeSignUpWithEmailPassword: CompleteSignUpMutation },
  { emailCode }: { emailCode: string },
): { readonly current: CompleteSignUpState } {
  const { authClient, signInApi } = getConvexAuthContext(
    "useCompleteSignUpWithEmailPassword()",
  );
  return landingPage(
    createCompleteSignUpWithEmailPassword({
      authClient,
      signInApi,
      api,
      emailCode,
    }),
  );
}

//------------------------------------------------------------------------------
// Password recovery
//------------------------------------------------------------------------------

/**
 * Start a password recovery. On success, the backend emails a link, and the
 * page that the link opens calls {@link useCompletePasswordRecovery}.
 *
 * ```ts
 * const recovery = useStartPasswordRecovery(api.auth);
 *
 * async function onSubmit(email: string) {
 *   const result = await recovery.startPasswordRecovery({ email });
 *   if (result.success) {
 *     console.log(`Sent a link to ${result.sentTo}`);
 *   }
 * }
 * ```
 */
export function useStartPasswordRecovery(api: {
  startPasswordRecovery: StartPasswordRecoveryMutation;
}): {
  /** Start the recovery. Resolves to a result, never rejects. */
  startPasswordRecovery: (args: {
    email: string;
  }) => Promise<StartPasswordRecoveryResult>;
  /** `true` while the recovery is being started. */
  readonly pending: boolean;
} {
  const { authClient, convex } = getConvexAuthContext(
    "useStartPasswordRecovery()",
  );
  const client = createStartPasswordRecovery({ authClient, convex, api });
  return Object.assign(pendingOf(client.pending), {
    startPasswordRecovery: client.startPasswordRecovery,
  });
}

/**
 * Finish a password recovery from the link in the email. It checks the link
 * once the session has loaded. When `current.status` is `"ready"`, ask for
 * the new password and call `current.completePasswordRecovery`.
 *
 * ```ts
 * const emailCode = new URL(location.href).searchParams.get("code") ?? "";
 * const recovery = useCompletePasswordRecovery(api.auth, { emailCode });
 *
 * async function onSubmit(newPassword: string) {
 *   const state = recovery.current;
 *   if (state.status !== "ready") return;
 *   const result = await state.completePasswordRecovery({ newPassword });
 *   if (result.status === "error") {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 *
 * @param recoveryApi The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompletePasswordRecovery(
  recoveryApi: PasswordRecoveryApi,
  { emailCode }: { emailCode: string },
): { readonly current: CompletePasswordRecoveryState } {
  const { authClient, signInApi } = getConvexAuthContext(
    "useCompletePasswordRecovery()",
  );
  const client = createCompletePasswordRecovery({
    authClient,
    signInApi,
    api: recoveryApi,
    emailCode,
  });
  onMount(() => client.start());
  const progress = fromReadableStore(client.progress);
  // The arguments of the check depend on the secret alone. Reading the whole
  // progress there would subscribe to the check again on each change of
  // `pending` or of the outcome.
  const secret = fromReadableStore(
    selectStore(client.progress, ({ browserSecret }) => browserSecret),
  );
  // The check is reactive: the state moves to `error` on its own when the
  // link dies while the page is open.
  const check = useQuery(recoveryApi.checkPasswordRecovery, () => {
    void secret.current;
    return client.checkArgs();
  });
  return {
    get current() {
      void progress.current;
      return client.stateFor(check.data, check.error);
    },
  };
}

//------------------------------------------------------------------------------
// Email change
//------------------------------------------------------------------------------

/**
 * Start changing the email of the signed-in user. On success, the backend
 * emails a link to the new address, and the page that the link opens calls
 * {@link useCompleteChangeEmail}.
 *
 * ```ts
 * const change = useStartChangeEmail(api.auth);
 *
 * async function onSubmit(newEmail: string, currentPassword: string) {
 *   const result = await change.startChangeEmail({ newEmail, currentPassword });
 *   if (!result.success) {
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 */
export function useStartChangeEmail(api: {
  startChangeEmail: StartChangeEmailMutation;
}): {
  /** Start the change. Resolves to a result, never rejects. */
  startChangeEmail: (args: {
    newEmail: string;
    currentPassword: string;
  }) => Promise<StartChangeEmailResult>;
  /** `true` while the change is being started. */
  readonly pending: boolean;
} {
  const { authClient, convex } = getConvexAuthContext("useStartChangeEmail()");
  const client = createStartChangeEmail({ authClient, convex, api });
  return Object.assign(pendingOf(client.pending), {
    startChangeEmail: client.startChangeEmail,
  });
}

/**
 * Finish an email change from the link in the email. It runs on its own once
 * the session has loaded: render from `current`.
 *
 * ```ts
 * const emailCode = new URL(location.href).searchParams.get("code") ?? "";
 * const change = useCompleteChangeEmail(api.auth, { emailCode });
 * // In the template: {#if change.current.status === "complete"}…{/if}
 * ```
 *
 * @param api The functions of the method, usually `api.auth`.
 * @param emailCode The `code` query parameter of the link.
 */
export function useCompleteChangeEmail(
  api: { completeChangeEmail: CompleteChangeEmailMutation },
  { emailCode }: { emailCode: string },
): { readonly current: CompleteChangeEmailState } {
  const { authClient, convex } = getConvexAuthContext(
    "useCompleteChangeEmail()",
  );
  return landingPage(
    createCompleteChangeEmail({ authClient, convex, api, emailCode }),
  );
}
