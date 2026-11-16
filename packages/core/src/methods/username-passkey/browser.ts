/**
 * Framework-agnostic client for the `usernamePasskey` method, exported at
 * `@convex-dev/auth/methods/username-passkey/browser`. The React hooks of
 * `@convex-dev/auth/methods/username-passkey/react` wrap it, and a binding
 * for another framework can too.
 *
 * It has three layers, from the most to the least batteries-included:
 *
 * - The clients of a page: {@link createSignInWithUsernamePasskey} (the
 *   login form, with passkey autofill), {@link createAddPasskey} and
 *   {@link createRemovePasskey} (the settings page). Each returns plain
 *   async functions and a {@link ReadableStore} for its state. Make one per
 *   component instance.
 * - The building blocks they are made of: the autofill loop
 *   ({@link createPasskeyAutofill}), the slot that runs one modal ceremony
 *   at a time ({@link createPasskeyCeremonySlot}), and the flows
 *   ({@link runSignInOrSignUpFlow}, {@link runAddPasskeyFlow},
 *   {@link runRemovePasskeyFlow}).
 * - The ceremonies: {@link browserCeremonies} runs them in a browser,
 *   through `@simplewebauthn/browser`. {@link resolveCeremonies} turns the
 *   ceremonies of another platform (for example a React Native passkey
 *   library) into the same shape.
 *
 * The functions never throw: they return discriminated unions, and fold
 * every failure into a `userError`.
 *
 * ```ts
 * import type { AuthClient, AuthSignInApi } from "@convex-dev/auth/browser";
 * import {
 *   browserCeremonies,
 *   createSignInWithUsernamePasskey,
 * } from "@convex-dev/auth/methods/username-passkey/browser";
 * import { ConvexClient } from "convex/browser";
 * import { api } from "../convex/_generated/api";
 *
 * declare const authClient: AuthClient;
 * declare const signInApi: AuthSignInApi;
 * declare const convex: ConvexClient;
 *
 * // The login form. Its username field has `autocomplete="username webauthn"`.
 * const login = createSignInWithUsernamePasskey({
 *   authClient,
 *   signInApi,
 *   convex: { mutation: (fn, args) => convex.mutation(fn, args) },
 *   api: api.auth,
 *   ceremonies: browserCeremonies,
 * });
 * login.autofill.subscribe(() => {
 *   const { status, lastError } = login.autofill.get();
 *   console.log(status, lastError?.error);
 * });
 * // On mount: offer the stored passkeys in the autocompletion list. The
 * // returned function is the cleanup, for the unmount.
 * const stopAutofill = login.startAutofill();
 *
 * async function onSubmit(username: string) {
 *   const result = await login.signIn({ username });
 *   if (result.status === "error") {
 *     // map result.userError (CEREMONY_ABORTED, …) to a message
 *     console.log(result.userError.error);
 *   }
 * }
 * ```
 *
 * @module
 */

export {
  authenticate,
  authenticateWithAutofill,
  browserCeremonies,
  isConditionalMediationAvailable,
  register,
  supportsWebAuthn,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WireAuthenticationResponse,
  type WireCreationOptions,
  type WireRegistrationResponse,
  type WireRequestOptions,
} from "./client.ts";
export {
  foldClientError,
  resolveCeremonies,
  type PasskeyAuthenticationResponse,
  type PasskeyAuthenticationResult,
  type PasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyClientFailure,
  type PasskeyRegistrationResponse,
  type PasskeyRegistrationResult,
  type ResolvedPasskeyCeremonies,
} from "./ceremonies.ts";
export {
  runSignInOrSignUpFlow,
  type SignInFlowContext,
  type SignInFlowResult,
  type UsernamePasskeyApi,
  type UsernamePasskeyAutofillError,
} from "./flows.ts";
export {
  runAddPasskeyFlow,
  runRemovePasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type ManagementFlowContext,
  type RemovePasskeyApi,
  type RemovePasskeyFlowResult,
} from "./management/flows.ts";
export {
  createPasskeyAutofill,
  createPasskeyCeremonySlot,
  type AlreadyPendingError,
  type AlreadyPendingFailure,
  type PasskeyAutofill,
  type PasskeyAutofillGates,
  type PasskeyAutofillOptions,
  type PasskeyAutofillState,
  type PasskeyAutofillStatus,
  type PasskeyCeremonySlot,
} from "./autofill.ts";
export {
  createSignInWithUsernamePasskey,
  type SignInWithUsernamePasskeyClient,
  type SignInWithUsernamePasskeyOptions,
  type SignInWithUsernamePasskeyResult,
} from "./signInClient.ts";
export {
  createAddPasskey,
  createRemovePasskey,
  type AddPasskeyClient,
  type AddPasskeyResult,
  type PasskeyManagementOptions,
  type RemovePasskeyClient,
  type RemovePasskeyResult,
} from "./management/managementClient.ts";
// The results of the functions of the method, for a binding that calls the
// ones without a client (`listPasskeys`, `renamePasskey`) itself.
export type {
  FinishSignInResult,
  FinishSignUpResult,
  StartAutofillSignInResult,
  StartSignInResult,
} from "./server.ts";
export type { ListPasskeysResult } from "./management/list.ts";
export type { RenamePasskeyResult } from "./management/rename.ts";
export type {
  FinishAddPasskeyResult,
  StartAddPasskeyResult,
  VerifyAddPasskeyResult,
} from "./management/add.ts";
export type {
  FinishRemovePasskeyResult,
  StartRemovePasskeyResult,
} from "./management/remove.ts";
export type { ReadableStore } from "../../browser/store.ts";
