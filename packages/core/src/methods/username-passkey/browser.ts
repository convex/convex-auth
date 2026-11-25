/**
 * Framework-agnostic client for the `usernamePasskey` method, exported at
 * `@convex-dev/auth/methods/username-passkey/browser`. The React hooks of
 * `@convex-dev/auth/methods/username-passkey/react` wrap it, and a binding
 * for another framework can too.
 *
 * It has two parts:
 *
 * - The clients of a page: {@link createSignInWithUsernamePasskey} (the
 *   login form, with passkey autofill), {@link createAddPasskey} and
 *   {@link createRemovePasskey} (the settings page). Each returns plain
 *   async functions and a {@link ReadableStore} for its state. Make one per
 *   component instance.
 * - The ceremonies that the clients run: {@link browserCeremonies} runs them
 *   in a browser, through `@simplewebauthn/browser`. {@link resolveCeremonies}
 *   turns the ceremonies of another platform (for example a React Native
 *   passkey library) into the same shape.
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
  browserCeremonies,
  type WireCreationOptions,
  type WireRequestOptions,
} from "./client.ts";
export {
  resolveCeremonies,
  type PasskeyAuthenticationResponse,
  type PasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyClientFailure,
  type PasskeyRegistrationResponse,
  type ResolvedPasskeyCeremonies,
} from "./ceremonies.ts";
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
export type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
export type { AddPasskeyApi, RemovePasskeyApi } from "./management/flows.ts";
export type {
  AlreadyPendingError,
  AlreadyPendingFailure,
  PasskeyAutofillState,
  PasskeyAutofillStatus,
} from "./autofill.ts";
// The results of the functions without a client, which a binding calls on
// its own Convex client.
export type { ListPasskeysResult } from "./management/list.ts";
export type { RenamePasskeyResult } from "./management/rename.ts";
export type { ReadableStore } from "../../browser/store.ts";
