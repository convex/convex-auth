/**
 * React Native client for the `usernamePasskey` method, exported at
 * `@convex-dev/auth/methods/username-passkey/react-native`.
 *
 * It has the same hooks as `@convex-dev/auth/methods/username-passkey/react`,
 * with the same arguments and results. They run the passkey ceremonies
 * through `react-native-passkeys`, which the app installs, instead of the
 * browser's WebAuthn API.
 *
 * The `autofill` field of {@link useSignInWithUsernamePasskey} reports
 * `available: false` and `status: "stopped"`: passkey autofill runs in
 * browsers only.
 *
 * @module
 */

import type { UsernamePasskeyApi } from "./flows.ts";
import { useSignInWithUsernamePasskeyImpl } from "./hooks.tsx";
import {
  useAddPasskeyImpl,
  useRemovePasskeyImpl,
  type AddPasskeyApi,
  type RemovePasskeyApi,
} from "./management/react.tsx";
import { nativeCeremonies } from "./nativeClient.ts";

export type { SignInWithUsernamePasskeyResult } from "./hooks.tsx";
export type { RenamePasskeyResult } from "./management/rename.ts";
export type {
  AddPasskeyApi,
  AddPasskeyResult,
  RemovePasskeyApi,
  RemovePasskeyResult,
} from "./management/react.tsx";
export type { PasskeyClientError, PasskeyClientFailure } from "./ceremonies.ts";
export type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
export type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "./react_impl.tsx";

/**
 * Client for the log in screen in the “username + passkey” auth flow, in a
 * React Native app.
 *
 * It runs the identifier-first flow: the user enters a username, then
 * either registers a new passkey or signs in with an existing one.
 *
 * ```tsx skip-check
 * import { useSignInWithUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/react-native";
 * import { useState } from "react";
 * import { Button, Text, TextInput, View } from "react-native";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithUsernamePasskey(api.auth);
 *   const [username, setUsername] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   // The text shows the error codes. Map each code to a message for the user.
 *   return (
 *     <View>
 *       <TextInput
 *         value={username}
 *         onChangeText={setUsername}
 *         textContentType="username"
 *         autoCapitalize="none"
 *         editable={!pending}
 *       />
 *       {error !== null && <Text>{error}</Text>}
 *       <Button
 *         title={pending ? "Waiting for your passkey…" : "Continue with a passkey"}
 *         disabled={pending}
 *         onPress={async () => {
 *           setError(null);
 *           const result = await signIn({ username });
 *           if (result.status === "error") {
 *             setError(result.userError.error);
 *           }
 *         }}
 *       />
 *     </View>
 *   );
 * }
 * ```
 *
 * @param usernamePasskeyApi The functions of the method, usually `api.auth`.
 */
export function useSignInWithUsernamePasskey(
  usernamePasskeyApi: UsernamePasskeyApi,
) {
  return useSignInWithUsernamePasskeyImpl(usernamePasskeyApi, nativeCeremonies);
}

/**
 * Hook for the "Add a passkey" button of a settings screen, in a React
 * Native app.
 *
 * First asks the user to authenticate with an existing passkey to prove
 * their identity, then registers a new passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the method, for example `api.auth`.
 */
export function useAddPasskey(managementApi: AddPasskeyApi) {
  return useAddPasskeyImpl(managementApi, nativeCeremonies);
}

/**
 * Hook for the "Remove" button of a passkey list, in a React Native app.
 *
 * This asks the user to reauthenticate with another passkey before
 * deleting the targeted passkey.
 *
 * @param managementApi The app module that re-exports the
 *   passkey-management functions of the method, for example `api.auth`.
 */
export function useRemovePasskey(managementApi: RemovePasskeyApi) {
  return useRemovePasskeyImpl(managementApi, nativeCeremonies);
}
