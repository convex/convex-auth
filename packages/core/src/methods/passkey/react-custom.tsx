/**
 * The hooks of the `passkey` method on ceremonies that the app provides, for
 * example on a React Native passkey library. Exported at
 * `@convex-dev/auth/methods/passkey/react-custom`.
 *
 * @module
 */
"use client";

import {
  resolveCeremonies,
  type PasskeyCeremonies,
} from "../username-passkey/ceremonies.ts";
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
  PasskeyAuthenticationResponse,
  PasskeyCeremonies,
  PasskeyClientError,
  PasskeyClientFailure,
  PasskeyRegistrationResponse,
} from "../username-passkey/ceremonies.ts";
export type {
  WireCreationOptions,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "../username-passkey/react_impl.tsx";

/**
 * Make the hooks of the `passkey` method on the given ceremonies. They take
 * the same arguments and return the same results as the hooks of
 * `@convex-dev/auth/methods/passkey/react`.
 *
 * Call it once, at the top level of a module:
 *
 * ```ts skip-check
 * export const {
 *   useSignInWithPasskey,
 *   useAddPasskey,
 *   useReauthenticateWithPasskey,
 * } = createPasskeyHooks(ceremonies);
 * ```
 */
export function createPasskeyHooks(ceremonies: PasskeyCeremonies) {
  const resolved = resolveCeremonies(ceremonies);
  return {
    useSignInWithPasskey: (api: PasskeySignInApi) =>
      useSignInWithPasskeyImpl(api, resolved),
    useAddPasskey: (api: AddPasskeyApi) => useAddPasskeyImpl(api, resolved),
    useReauthenticateWithPasskey: (api: PasskeyReauthenticationApi) =>
      useReauthenticateWithPasskeyImpl(api, resolved),
  };
}
