/**
 * Framework-agnostic browser client for the username-passkey method.
 *
 * The React hooks in `react.tsx` are built on it. Client libraries for other
 * frameworks import it from `@convex-dev/auth/methods/username-passkey`.
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
 * {@link browserCeremonies} bundles them in the {@link ResolvedPasskeyCeremonies}
 * shape that the flows and hooks take.
 *
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
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
import { fromBase64URL, toBase64URL } from "./base64url.ts";
import {
  foldClientError,
  pruneAuthenticationResponse,
  pruneRegistrationResponse,
  type PasskeyAuthenticationResult,
  type ResolvedPasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyRegistrationResult,
} from "./ceremonies.ts";

export {
  foldClientError,
  type PasskeyAuthenticationResult,
  type ResolvedPasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyClientFailure,
  type PasskeyRegistrationResult,
} from "./ceremonies.ts";

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

/**
 * Whether this browser can offer passkeys in the autocompletion list of an
 * `<input autoComplete="… webauthn">`. Never throws.
 */
export async function isConditionalMediationAvailable(): Promise<boolean> {
  // Feature-detect conditional mediation. The method is a static one,
  // and it is absent in older browsers: guard before calling it. Count
  // a rejection as "not available".
  let supported = false;
  try {
    supported =
      supportsWebAuthn() &&
      typeof PublicKeyCredential.isConditionalMediationAvailable ===
        "function" &&
      (await PublicKeyCredential.isConditionalMediationAvailable());
  } catch {
    // Keep `supported` as `false`.
  }
  return supported;
}

// The page events after which a pending autofill request re-checks the age
// of its challenge right away, rather than on the next periodic check: the
// user coming back to the page, and the user focusing a field (such as the
// username field whose autocompletion list offers the passkeys).
const STALENESS_CHECK_WINDOW_EVENTS = ["focus", "pageshow"] as const;
const STALENESS_CHECK_DOCUMENT_EVENTS = [
  "visibilitychange",
  "focusin",
] as const;

/** See {@link ResolvedPasskeyCeremonies.onResume}. */
function onPageResume(listener: () => void): () => void {
  for (const event of STALENESS_CHECK_WINDOW_EVENTS) {
    window.addEventListener(event, listener);
  }
  for (const event of STALENESS_CHECK_DOCUMENT_EVENTS) {
    document.addEventListener(event, listener);
  }
  return () => {
    for (const event of STALENESS_CHECK_WINDOW_EVENTS) {
      window.removeEventListener(event, listener);
    }
    for (const event of STALENESS_CHECK_DOCUMENT_EVENTS) {
      document.removeEventListener(event, listener);
    }
  };
}

/** The browser ceremonies, which the hooks of `react.tsx` run. */
export const browserCeremonies: ResolvedPasskeyCeremonies = {
  isSupported: supportsWebAuthn,
  register,
  authenticate,
  isAutofillAvailable: isConditionalMediationAvailable,
  authenticateWithAutofill,
  onResume: onPageResume,
};
