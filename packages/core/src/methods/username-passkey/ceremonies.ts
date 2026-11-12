/**
 * The platform-neutral part of the passkey clients: the result shapes of a
 * ceremony, the {@link PasskeyCeremonies} interface that each platform
 * implements, and the helpers that the implementations share. The flows and
 * hooks take a {@link PasskeyCeremonies} as an argument, so they hold no
 * platform code.
 *
 * @module
 */

import type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";

/**
 * The failures the client side produces (the server never returns these):
 *
 * - `CEREMONY_ABORTED`: the user dismissed the passkey dialog, the platform
 *   refused the ceremony (`NotAllowedError`), or another ceremony displaced
 *   this one. This is the most common failure; show a calm "sign-in was
 *   cancelled" message.
 * - `PASSKEY_ALREADY_REGISTERED`: the authenticator refused a registration
 *   because it already holds a passkey for this account
 *   (`InvalidStateError`, usually via `excludeCredentials`). Tell the user
 *   they can sign in with the passkey they already have.
 * - `WEBAUTHN_UNSUPPORTED`: this runtime cannot run passkey ceremonies.
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
 * A failed result with a client-side `userError`. The failure arm all the
 * ceremony functions and hooks share; it composes with the server's own
 * `{ success: false, userError }` results into one `userError` switch.
 */
export type PasskeyClientFailure = {
  success: false;
  userError: PasskeyClientError;
};

/**
 * The result of a registration ceremony: the response to send to the finish
 * mutation, or a user-facing `userError`.
 */
export type PasskeyRegistrationResult =
  { success: true; response: WireRegistrationResponse } | PasskeyClientFailure;

/**
 * The result of an authentication ceremony: the response to send to the finish
 * mutation, or a user-facing `userError`.
 */
export type PasskeyAuthenticationResult =
  | { success: true; response: WireAuthenticationResponse }
  | PasskeyClientFailure;

/**
 * The ceremonies of one platform. The flows and hooks run every ceremony
 * through one of these.
 *
 * The functions never throw. They return discriminated unions, and they
 * fold every failure into the {@link PasskeyClientError} shape.
 */
export type PasskeyCeremonies = {
  /**
   * Whether this runtime can run passkey ceremonies. The flows check it
   * before they call a start mutation.
   */
  isSupported: () => boolean;
  /** Run a modal registration ceremony. */
  register: (
    options: WireCreationOptions,
  ) => Promise<PasskeyRegistrationResult>;
  /** Run a modal authentication ceremony. */
  authenticate: (
    options: WireRequestOptions,
  ) => Promise<PasskeyAuthenticationResult>;
  /**
   * Whether this runtime can offer passkeys in the autocompletion list of
   * a field. The autofill flow only starts when this resolves `true`.
   */
  isAutofillAvailable: () => Promise<boolean>;
  /**
   * Run a conditional-mediation ceremony, which stays pending until the
   * user picks a passkey in the autocompletion list. `signal` aborts it.
   */
  authenticateWithAutofill: (
    options: WireRequestOptions,
    signal: AbortSignal,
  ) => Promise<PasskeyAuthenticationResult>;
  /**
   * Call `listener` when the user may have come back to the app after a
   * pause. The autofill flow uses it to refresh a stale challenge without
   * waiting for its next periodic check. Returns the unsubscribe function.
   */
  onResume: (listener: () => void) => () => void;
};

/** Whether `cause` is a `DOMException`, which is not a global in every
 * runtime. */
function isDOMException(cause: unknown): cause is DOMException {
  return typeof DOMException !== "undefined" && cause instanceof DOMException;
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
  if (cause instanceof Error || isDOMException(cause)) {
    if (cause.name === "NotAllowedError" || cause.name === "AbortError") {
      return { error: "CEREMONY_ABORTED" };
    }
  }
  return { error: "OTHER_ERROR", cause };
}

/** The registration response shape that the platform libraries return. */
type PlatformRegistrationResponse = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[] | null;
  };
  type: "public-key";
};

/** The authentication response shape that the platform libraries return. */
type PlatformAuthenticationResponse = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
  type: "public-key";
};

/**
 * Keep only the fields of a registration response that the finish
 * mutations accept. The platform libraries add convenience fields
 * (`publicKey`, `publicKeyAlgorithm`, `authenticatorData`,
 * `authenticatorAttachment`) that duplicate data from the attestation
 * object, and the exact server validators refuse them.
 * A missing optional field may come back as `null`, which the validators
 * refuse too.
 */
export function pruneRegistrationResponse(
  response: PlatformRegistrationResponse,
): WireRegistrationResponse {
  return {
    id: response.id,
    rawId: response.rawId,
    response: {
      clientDataJSON: response.response.clientDataJSON,
      attestationObject: response.response.attestationObject,
      ...(response.response.transports != null
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
export function pruneAuthenticationResponse(
  response: PlatformAuthenticationResponse,
): WireAuthenticationResponse {
  return {
    id: response.id,
    rawId: response.rawId,
    response: {
      clientDataJSON: response.response.clientDataJSON,
      authenticatorData: response.response.authenticatorData,
      signature: response.response.signature,
      ...(response.response.userHandle != null
        ? { userHandle: response.response.userHandle }
        : {}),
    },
    clientExtensionResults: {},
    type: response.type,
  };
}
