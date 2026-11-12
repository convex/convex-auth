/**
 * The passkey hooks on ceremonies that the app provides, for example on a
 * React Native passkey library. Exported at
 * `@convex-dev/auth/methods/username-passkey/react-custom`.
 *
 * @module
 */
"use client";

import { resolveCeremonies, type PasskeyCeremonies } from "./ceremonies.ts";
import type { UsernamePasskeyApi } from "./flows.ts";
import { useSignInWithUsernamePasskeyImpl } from "./hooks.tsx";
import {
  useAddPasskeyImpl,
  useRemovePasskeyImpl,
  type AddPasskeyApi,
  type RemovePasskeyApi,
} from "./management/react.tsx";

export type { SignInWithUsernamePasskeyResult } from "./hooks.tsx";
export type { RenamePasskeyResult } from "./management/rename.ts";
export type {
  AddPasskeyApi,
  AddPasskeyResult,
  RemovePasskeyApi,
  RemovePasskeyResult,
} from "./management/react.tsx";
export type {
  PasskeyAuthenticationResponse,
  PasskeyCeremonies,
  PasskeyClientError,
  PasskeyClientFailure,
  PasskeyRegistrationResponse,
} from "./ceremonies.ts";
export type {
  WireCreationOptions,
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
 * Make the passkey hooks on the given ceremonies. They take the same
 * arguments and return the same results as the hooks of
 * `@convex-dev/auth/methods/username-passkey/react`.
 *
 * Call it once, at the top level of a module:
 *
 * ```ts skip-check
 * export const { useSignInWithUsernamePasskey, useAddPasskey, useRemovePasskey } =
 *   createUsernamePasskeyHooks(ceremonies);
 * ```
 */
export function createUsernamePasskeyHooks(ceremonies: PasskeyCeremonies) {
  const resolved = resolveCeremonies(ceremonies);
  return {
    useSignInWithUsernamePasskey: (api: UsernamePasskeyApi) =>
      useSignInWithUsernamePasskeyImpl(api, resolved),
    useAddPasskey: (api: AddPasskeyApi) => useAddPasskeyImpl(api, resolved),
    useRemovePasskey: (api: RemovePasskeyApi) =>
      useRemovePasskeyImpl(api, resolved),
  };
}
