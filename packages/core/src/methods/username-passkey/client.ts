/**
 * Framework-agnostic browser client for the username-passkey method.
 *
 * This module is internal: the public surface of the method is the React
 * hooks in `react.tsx`, which are built on it. The `exports` field of the
 * package blocks `providers/passkey/client`, so an app cannot import this
 * file. It becomes a public entry point only when a real non-React consumer
 * asks for one.
 *
 * These functions wrap the modal WebAuthn ceremonies through
 * `@simplewebauthn/browser`. They do not call any Convex function: a flow
 * gets an `options` object from its start mutation, runs the ceremony here,
 * and sends the response to its finish mutation.
 *
 * The functions never throw. They return discriminated unions, and they
 * fold every failure into the {@link PasskeyClientError} shape, so callers
 * handle every failure through one `userError` switch and never need their
 * own `try`/`catch`.
 *
 * @internal
 * @module
 */

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
import { fromBase64URL, toBase64URL } from "./base64url.ts";

// Apps and custom flows read the WebAuthn JSON types from here, so they
// never depend on `@simplewebauthn/*` directly. The `Wire…` variants are
// the exact shapes of the mutations of the method.
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};
export type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";

/**
 * The failures the browser side produces (the server never returns these):
 *
 * - `CEREMONY_ABORTED`: the user dismissed the passkey dialog, the browser
 *   refused the ceremony (`NotAllowedError`), or another ceremony displaced
 *   this one. This is the most common failure; show a calm "sign-in was
 *   cancelled" message.
 * - `PASSKEY_ALREADY_REGISTERED`: the authenticator refused a registration
 *   because it already holds a passkey for this account
 *   (`InvalidStateError`, usually via `excludeCredentials`). Tell the user
 *   they can sign in with the passkey they already have.
 * - `WEBAUTHN_UNSUPPORTED`: the browser has no WebAuthn support, or the
 *   page is not a secure context.
 * - `OTHER_ERROR`: everything else thrown (a network blip, a bug, an
 *   unexpected server error). The thrown value is preserved on `cause` for
 *   callers that want to inspect or log it.
 */
export type PasskeyClientError =
  | { error: "CEREMONY_ABORTED" }
  | { error: "PASSKEY_ALREADY_REGISTERED" }
  | { error: "WEBAUTHN_UNSUPPORTED" }
  | { error: "OTHER_ERROR"; cause: unknown };

/**
 * A failed result with a browser-side `userError`. The failure arm all the
 * ceremony functions and hooks share; it composes with the server's own
 * `{ success: false, userError }` results into one `userError` switch.
 */
export type PasskeyClientFailure = {
  success: false;
  userError: PasskeyClientError;
};

/**
 * The result of {@link register}: the response to send to the finish
 * mutation, or a user-facing `userError`.
 */
export type PasskeyRegistrationResult =
  { success: true; response: WireRegistrationResponse } | PasskeyClientFailure;

/**
 * The result of {@link authenticate}: the response to send to the finish
 * mutation, or a user-facing `userError`.
 */
export type PasskeyAuthenticationResult =
  | { success: true; response: WireAuthenticationResponse }
  | PasskeyClientFailure;

/**
 * Whether this browser can run WebAuthn ceremonies on this page. The
 * ceremony functions run this check themselves; call it directly to hide a
 * passkey button up front.
 */
export function supportsWebAuthn(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof PublicKeyCredential !== "undefined" &&
    window.isSecureContext
  );
}

/**
 * Fold a thrown value into the {@link PasskeyClientError} shape, so callers
 * handle every failure through one `userError` switch.
 *
 * The browser errors keep their `name` when `@simplewebauthn/browser` wraps
 * them in a `WebAuthnError`, so one check covers both the wrapped and the
 * raw form. `NotAllowedError` is what the browser throws when the user
 * dismisses the dialog, when the ceremony times out, and when the page is
 * not allowed to run one. `AbortError` is a ceremony that another one
 * displaced. A `null` credential cannot happen through
 * `@simplewebauthn/browser` (it throws instead).
 */
export function foldClientError(cause: unknown): PasskeyClientError {
  // `DOMException` does not extend `Error` in every runtime.
  if (cause instanceof Error || cause instanceof DOMException) {
    if (cause.name === "NotAllowedError" || cause.name === "AbortError") {
      return { error: "CEREMONY_ABORTED" };
    }
  }
  return { error: "OTHER_ERROR", cause };
}

/**
 * Fold a thrown value from a registration ceremony, which has one failure
 * that no other ceremony produces: `InvalidStateError`, the authenticator
 * refusing to make a second passkey for a credential in
 * `excludeCredentials`. An authentication ceremony that somehow throws it
 * means something else, so that fold stays in {@link foldClientError}.
 */
function foldRegistrationError(cause: unknown): PasskeyClientError {
  if (
    (cause instanceof Error || cause instanceof DOMException) &&
    cause.name === "InvalidStateError"
  ) {
    return { error: "PASSKEY_ALREADY_REGISTERED" };
  }
  return foldClientError(cause);
}

/**
 * Keep only the fields of a registration response that the finish
 * mutations accept. `@simplewebauthn/browser` adds convenience fields
 * (`publicKey`, `publicKeyAlgorithm`, `authenticatorData`,
 * `authenticatorAttachment`) that duplicate data from the attestation
 * object, and the exact server validators refuse them.
 */
function pruneRegistrationResponse(
  response: RegistrationResponseJSON,
): WireRegistrationResponse {
  return {
    id: response.id,
    rawId: response.rawId,
    response: {
      clientDataJSON: response.response.clientDataJSON,
      attestationObject: response.response.attestationObject,
      ...(response.response.transports !== undefined
        ? { transports: response.response.transports }
        : {}),
    },
    // The options request no extensions, so there is nothing to report.
    clientExtensionResults: {},
    type: response.type,
  };
}

/** Keep only the fields of an authentication response that the finish
 * mutations accept (see {@link pruneRegistrationResponse}). */
function pruneAuthenticationResponse(
  response: AuthenticationResponseJSON,
): WireAuthenticationResponse {
  return {
    id: response.id,
    rawId: response.rawId,
    response: {
      clientDataJSON: response.response.clientDataJSON,
      authenticatorData: response.response.authenticatorData,
      signature: response.response.signature,
      ...(response.response.userHandle !== undefined
        ? { userHandle: response.response.userHandle }
        : {}),
    },
    clientExtensionResults: {},
    type: response.type,
  };
}

/**
 * Run a modal registration ceremony (a WebAuthn `create()` call).
 *
 * `options` comes from a start mutation, ready for the browser. Starting a
 * ceremony displaces a pending one anywhere on the page: the browser runs
 * one ceremony at a time, and the pending one rejects with an
 * `AbortError`.
 */
export async function register(
  options: WireCreationOptions,
): Promise<PasskeyRegistrationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const response = await startRegistration({
      // The wire keeps `transports` as free-form strings, because the
      // WebAuthn spec lets new transports appear; the library type does
      // not.
      optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
    });
    return { success: true, response: pruneRegistrationResponse(response) };
  } catch (cause) {
    return { success: false, userError: foldRegistrationError(cause) };
  }
}

/**
 * Run a modal authentication ceremony
 * (a WebAuthn `navigator.credentials.get()` call).
 *
 * `options` comes from a start mutation, ready for the browser. Starting a
 * ceremony displaces a pending one anywhere on the page: the browser runs
 * one ceremony at a time, and the pending one rejects with an
 * `AbortError`.
 *
 * For the conditional-mediation flow, which stays pending until the user
 * picks a passkey in the autocompletion list of an
 * `<input autoComplete="… webauthn">`, use
 * {@link authenticateWithAutofill}.
 */
export async function authenticate(
  options: WireRequestOptions,
): Promise<PasskeyAuthenticationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const response = await startAuthentication({
      // See the `transports` note in `register`.
      optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
    });
    return { success: true, response: pruneAuthenticationResponse(response) };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}

/**
 * Run a conditional-mediation ceremony: the request stays pending until the
 * user picks a passkey in the autocompletion list of an
 * `<input autoComplete="… webauthn">`.
 *
 * `signal` aborts it. This is required because the caller is expected to
 * periodically recreate a new ceremony (because every ceremony has a timeout).
 *
 * This one call does not go through `@simplewebauthn/browser`, because its
 * autofill integration doesn’t handle correctly restarting autofill requests
 * after modal passkey ceremonies failed.
 */
export async function authenticateWithAutofill(
  options: WireRequestOptions,
  signal: AbortSignal,
): Promise<PasskeyAuthenticationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const credential = await navigator.credentials.get({
      mediation: "conditional",
      signal,
      publicKey: {
        challenge: fromBase64URL(options.challenge),
        timeout: options.timeout,
        rpId: options.rpId,
        // Conditional mediation requires an empty allow-list: the passkey
        // the user picks in the autocompletion list identifies the account.
        allowCredentials: [],
        userVerification: options.userVerification,
      },
    });
    if (credential === null) {
      // The spec lets `get()` resolve with `null`. No assertion means no
      // ceremony, which is the same outcome for a caller as an abort.
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return {
      success: true,
      response: assertionToJSON(credential as PublicKeyCredential),
    };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}

/**
 * Put an assertion credential from a `navigator.credentials.get()`
 * call into the wire shape.
 */
function assertionToJSON(
  credential: PublicKeyCredential,
): WireAuthenticationResponse {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64URL(credential.rawId),
    response: {
      clientDataJSON: toBase64URL(response.clientDataJSON),
      authenticatorData: toBase64URL(response.authenticatorData),
      signature: toBase64URL(response.signature),
      ...(response.userHandle !== null
        ? { userHandle: toBase64URL(response.userHandle) }
        : {}),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
