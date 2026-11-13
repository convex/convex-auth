/**
 * React client for the `passkey` method, exported at
 * `@convex-dev/auth/methods/passkey/react`.
 *
 * {@link useSignInWithPasskey} signs a user in with a passkey, from a button
 * or from the autofill of a sign-in form. {@link useAddPasskey} adds a
 * passkey to the account of a signed-in user, and
 * {@link useReauthenticateWithPasskey} asks the user for a passkey before a
 * sensitive action.
 *
 * To remove or rename a passkey, call the `removePasskey` and
 * `renamePasskey` mutations with `useMutation`. To list the passkeys, read
 * the `listPasskeys` query with `useQuery`.
 *
 * @module
 */
"use client";

import { browserCeremonies } from "../username-passkey/client.ts";
import {
  useReauthenticateWithPasskeyImpl,
  type PasskeyReauthenticationApi,
} from "../username-passkey/management/react.tsx";
import type { AddPasskeyApi, PasskeySignInApi } from "./flows.ts";
import { useAddPasskeyImpl, useSignInWithPasskeyImpl } from "./hooks.tsx";

export type { AddPasskeyResult, SignInWithPasskeyResult } from "./hooks.tsx";
export type {
  AddPasskeyApi,
  PasskeyAutofillError,
  PasskeySignInApi,
} from "./flows.ts";
export type {
  PasskeyReauthenticationApi,
  ReauthenticateWithPasskeyResult,
} from "../username-passkey/management/react.tsx";
export type { RenamePasskeyResult } from "../username-passkey/management/rename.ts";
export type { RemovePasskeyResult } from "./management.ts";
export type {
  PasskeyClientError,
  PasskeyClientFailure,
} from "../username-passkey/client.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "../username-passkey/react_impl.tsx";

/**
 * Hook for signing in with a passkey, without a username.
 *
 * `signIn` asks the browser for a passkey of this app, for a "Sign in with a
 * passkey" button. While the hook is mounted, the browser also offers the
 * passkeys in the autocompletion list of a field with
 * `autoComplete="username webauthn"`, such as the email field of the
 * sign-in form.
 *
 * ```tsx
 * import { useSignInWithPasskey } from "@convex-dev/auth/methods/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function SignInWithPasskey() {
 *   const { signIn, pending, autofill } = useSignInWithPasskey(api.passkey);
 *   return (
 *     <>
 *       <input type="email" autoComplete="username webauthn" />
 *       {autofill.lastError !== null && (
 *         <p role="alert">{autofill.lastError.error}</p>
 *       )}
 *       <button
 *         disabled={pending}
 *         onClick={async () => {
 *           const result = await signIn();
 *           if (result.status === "error") {
 *             // map result.userError to a message
 *           }
 *         }}
 *       >
 *         Sign in with a passkey
 *       </button>
 *     </>
 *   );
 * }
 * ```
 *
 * @param passkeyApi The app module that re-exports the functions of the
 *   method, for example `api.passkey`.
 */
export function useSignInWithPasskey(passkeyApi: PasskeySignInApi) {
  return useSignInWithPasskeyImpl(passkeyApi, browserCeremonies);
}

/**
 * Hook for the "Add a passkey" button of a settings page.
 *
 * The user must have authenticated recently: see the
 * `maxAuthenticationAgeSeconds` option of `setupPasskey`. Otherwise
 * `addPasskey` returns `REAUTHENTICATION_REQUIRED`; ask the user to sign in
 * again, or to use {@link useReauthenticateWithPasskey}, then try again.
 *
 * ```tsx
 * import { useAddPasskey } from "@convex-dev/auth/methods/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function AddPasskeyButton() {
 *   const { addPasskey, pending } = useAddPasskey(api.passkey);
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
 * @param addPasskeyApi The app module that re-exports the functions of the
 *   method, for example `api.passkey`.
 */
export function useAddPasskey(addPasskeyApi: AddPasskeyApi) {
  return useAddPasskeyImpl(addPasskeyApi, browserCeremonies);
}

/**
 * Hook that asks the signed-in user for one of their passkeys before a
 * sensitive action. A verified passkey counts as a new authentication of the
 * current session, which `requireRecentAuthentication` then accepts. The
 * same hook serves the `usernamePasskey` method.
 *
 * ```tsx
 * import { useReauthenticateWithPasskey } from "@convex-dev/auth/methods/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function ConfirmButton({ onConfirmed }: { onConfirmed: () => void }) {
 *   const { reauthenticate, pending } = useReauthenticateWithPasskey(
 *     api.passkey,
 *   );
 *   return (
 *     <button
 *       disabled={pending}
 *       onClick={async () => {
 *         const result = await reauthenticate();
 *         if (result.success) onConfirmed();
 *       }}
 *     >
 *       Confirm with a passkey
 *     </button>
 *   );
 * }
 * ```
 *
 * @param reauthenticationApi The app module that re-exports
 *   `startPasskeyReauthentication` and `finishPasskeyReauthentication`, for
 *   example `api.passkey`.
 */
export function useReauthenticateWithPasskey(
  reauthenticationApi: PasskeyReauthenticationApi,
) {
  return useReauthenticateWithPasskeyImpl(
    reauthenticationApi,
    browserCeremonies,
  );
}
