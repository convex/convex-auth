/**
 * React client for the `usernamePasskey` method, exported at
 * `@convex-dev/auth/methods/username-passkey/react`.
 *
 * {@link useSignInWithUsernamePasskey} is the batteries-included hook for the
 * username + passkey login form. It drives the browser-side WebAuthn
 * ceremonies (through the internal client module built on
 * `@simplewebauthn/browser`) against the mutations of a passkey recipe,
 * and it handles both the identifier-first modal flow and passkey autofill
 * (conditional mediation), where the user selects an account directly in
 * the autocompletion list.
 *
 * {@link useAddPasskey} and {@link useRemovePasskey} (from
 * `management/react.tsx`) drive the passkey settings page of a signed-in
 * user. {@link useReauthenticateWithPasskey} asks the user for a passkey
 * before a sensitive action.
 *
 * @module
 */
"use client";

import { browserCeremonies } from "../../lib/passkey/client.ts";
import type { UsernamePasskeyApi } from "./flows.ts";
import { useSignInWithUsernamePasskeyImpl } from "./hooks.tsx";
import {
  useAddPasskeyImpl,
  useRemovePasskeyImpl,
  type AddPasskeyApi,
  type RemovePasskeyApi,
} from "./management/react.tsx";
import {
  useReauthenticateWithPasskeyImpl,
  type PasskeyReauthenticationApi,
} from "../../lib/passkey/reauthenticationHook.tsx";

export type { SignInWithUsernamePasskeyResult } from "./hooks.tsx";
export type { RenamePasskeyResult } from "../../lib/passkey/rename.ts";
export {
  type AddPasskeyApi,
  type AddPasskeyResult,
  type RemovePasskeyApi,
  type RemovePasskeyResult,
} from "./management/react.tsx";
export type {
  PasskeyReauthenticationApi,
  ReauthenticateWithPasskeyResult,
} from "../../lib/passkey/reauthenticationHook.tsx";
// Apps read the WebAuthn JSON types and the browser-side failure shapes
// from here, so they never depend on `@simplewebauthn/*` directly.
export type {
  AuthenticationResponseJSON,
  PasskeyClientError,
  PasskeyClientFailure,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "../../lib/passkey/client.ts";
export type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "../../lib/passkey/react_impl.tsx";

/**
 * Client for the log in page in the “username + passkey” auth flow.
 *
 * This client handles both:
 * - Manually logging in by providing an identifier (e.g. username)
 *   then registering a new passkey or logging in
 * - Passkey autofill (conditional mediation) where the user selects an account
 *   directly in the autocompletion list.
 *
 * ```tsx
 * import { useSignInWithUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/react";
 * import { useState } from "react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   // While this hook is mounted, the browser also shows the stored passkeys
 *   // in the autocompletion list of the username field.
 *   const { signIn, pending, autofill } = useSignInWithUsernamePasskey(api.auth);
 *   const [username, setUsername] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   // The alerts show the error codes. Map each code to a message for the user.
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         setError(null);
 *         const result = await signIn({ username });
 *         if (result.status === "error") {
 *           setError(result.userError.error);
 *         }
 *       }}
 *     >
 *       <input
 *         type="text"
 *         value={username}
 *         onChange={(e) => setUsername(e.target.value)}
 *         autoComplete="username webauthn"
 *         required
 *         disabled={pending}
 *       />
 *       {error !== null && <p role="alert">{error}</p>}
 *       {autofill.lastError !== null && (
 *         <p role="alert">{autofill.lastError.error}</p>
 *       )}
 *       <button type="submit" disabled={pending}>
 *         {pending ? "Waiting for your passkey…" : "Continue with a passkey"}
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param usernamePasskeyApi The functions of the method, usually `api.auth`.
 */
export function useSignInWithUsernamePasskey(
  usernamePasskeyApi: UsernamePasskeyApi,
) {
  return useSignInWithUsernamePasskeyImpl(
    usernamePasskeyApi,
    browserCeremonies,
  );
}

/**
 * Hook for the "Add a passkey" button of a settings page.
 *
 * ```tsx
 * import { useAddPasskey } from "@convex-dev/auth/methods/username-passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function AddPasskeyButton() {
 *   const { addPasskey, pending } = useAddPasskey(api.auth);
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         const result = await addPasskey();
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       Add a passkey
 *     </button>
 *   );
 * }
 * ```
 *
 * First asks the user to authenticate with an existing passkey to prove
 * their identity, then registers a new passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the method, for example `api.auth`.
 */
export function useAddPasskey(managementApi: AddPasskeyApi) {
  return useAddPasskeyImpl(managementApi, browserCeremonies);
}

/**
 * Hook for the "Remove" button of a passkey list.
 *
 * ```tsx
 * import { useRemovePasskey } from "@convex-dev/auth/methods/username-passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function RemovePasskeyButton({ passkeyId }: { passkeyId: string }) {
 *   const { removePasskey, pending } = useRemovePasskey(api.auth);
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         const result = await removePasskey(passkeyId);
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       Remove
 *     </button>
 *   );
 * }
 * ```
 *
 * This asks the user to reauthenticate with another passkey
 * before deleting the targeted passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the method, for example `api.auth`.
 */
export function useRemovePasskey(managementApi: RemovePasskeyApi) {
  return useRemovePasskeyImpl(managementApi, browserCeremonies);
}

/**
 * Hook that asks the signed-in user for one of their passkeys before a
 * sensitive action. A verified passkey counts as a new authentication of the
 * current session, which `requireRecentAuthentication` then accepts.
 *
 * ```tsx
 * import { useReauthenticateWithPasskey } from "@convex-dev/auth/methods/username-passkey/react";
 * import { isReauthenticationRequiredError } from "@convex-dev/auth/react";
 * import { useMutation } from "convex/react";
 * import { api } from "../convex/_generated/api";
 *
 * function DeleteAccountButton() {
 *   const { reauthenticate, pending } = useReauthenticateWithPasskey(api.auth);
 *   const deleteAccount = useMutation(api.users.deleteAccount);
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         try {
 *           await deleteAccount();
 *         } catch (error) {
 *           if (!isReauthenticationRequiredError(error)) throw error;
 *           const result = await reauthenticate();
 *           if (result.success) await deleteAccount();
 *         }
 *       }}
 *     >
 *       Delete my account
 *     </button>
 *   );
 * }
 * ```
 *
 * @param reauthenticationApi The app module that re-exports
 *   `startPasskeyReauthentication` and `finishPasskeyReauthentication`, for
 *   example `api.auth`.
 */
export function useReauthenticateWithPasskey(
  reauthenticationApi: PasskeyReauthenticationApi,
) {
  return useReauthenticateWithPasskeyImpl(
    reauthenticationApi,
    browserCeremonies,
  );
}
