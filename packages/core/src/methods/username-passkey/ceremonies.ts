/**
 * The platform-neutral part of the passkey clients: the result shapes of a
 * ceremony, the {@link ResolvedPasskeyCeremonies} that the flows and hooks
 * run, and the helpers that the implementations share. An app implements the
 * looser {@link PasskeyCeremonies}, which {@link resolveCeremonies} turns into
 * the former. The flows and hooks hold no platform code.
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
export type ResolvedPasskeyCeremonies = {
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

/** A registration response in the WebAuthn JSON encoding, as the passkey
 * libraries return it. */
export type PasskeyRegistrationResponse = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[] | null;
  };
  type: "public-key";
};

/** An authentication response in the WebAuthn JSON encoding, as the passkey
 * libraries return it. */
export type PasskeyAuthenticationResponse = {
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
  response: PasskeyRegistrationResponse,
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
  response: PasskeyAuthenticationResponse,
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

/**
 * The passkey ceremonies of a platform, which an app implements to run the
 * passkey hooks outside a browser. `createUsernamePasskeyHooks` takes one.
 *
 * `register` and `authenticate` return the response of the platform as it is:
 * the hooks keep only the fields the server accepts. For a failure they
 * recognize, they return the matching {@link PasskeyClientError}. A thrown
 * error named `NotAllowedError` or `AbortError` becomes `CEREMONY_ABORTED`,
 * and any other thrown value becomes `OTHER_ERROR`.
 */
export type PasskeyCeremonies = {
  /** Whether this device can run passkey ceremonies. */
  isSupported: () => boolean;
  register: (
    options: WireCreationOptions,
  ) => Promise<
    | { success: true; response: PasskeyRegistrationResponse }
    | PasskeyClientFailure
  >;
  authenticate: (
    options: WireRequestOptions,
  ) => Promise<
    | { success: true; response: PasskeyAuthenticationResponse }
    | PasskeyClientFailure
  >;
  /** Passkey autofill. Without it, autofill reports `available: false`. */
  autofill?: {
    isAvailable: () => Promise<boolean>;
    authenticate: (
      options: WireRequestOptions,
      signal: AbortSignal,
    ) => Promise<
      | { success: true; response: PasskeyAuthenticationResponse }
      | PasskeyClientFailure
    >;
    onResume?: (listener: () => void) => () => void;
  };
};

/**
 * Turn the ceremonies of an app into the ones the flows run: prune the
 * responses, fold thrown values, and default autofill to unavailable.
 */
export function resolveCeremonies(
  ceremonies: PasskeyCeremonies,
): ResolvedPasskeyCeremonies {
  const { autofill } = ceremonies;
  const authenticated = (
    result:
      | { success: true; response: PasskeyAuthenticationResponse }
      | PasskeyClientFailure,
  ): PasskeyAuthenticationResult =>
    result.success
      ? {
          success: true,
          response: pruneAuthenticationResponse(result.response),
        }
      : result;
  const failed = (cause: unknown): PasskeyClientFailure => ({
    success: false,
    userError: foldClientError(cause),
  });

  return {
    isSupported: () => {
      try {
        return ceremonies.isSupported();
      } catch {
        return false;
      }
    },
    register: async (options) => {
      try {
        const result = await ceremonies.register(options);
        return result.success
          ? {
              success: true,
              response: pruneRegistrationResponse(result.response),
            }
          : result;
      } catch (cause) {
        return failed(cause);
      }
    },
    authenticate: async (options) => {
      try {
        return authenticated(await ceremonies.authenticate(options));
      } catch (cause) {
        return failed(cause);
      }
    },
    isAutofillAvailable: async () => {
      try {
        return (await autofill?.isAvailable()) ?? false;
      } catch {
        return false;
      }
    },
    authenticateWithAutofill: async (options, signal) => {
      if (autofill === undefined) {
        return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
      }
      try {
        return authenticated(await autofill.authenticate(options, signal));
      } catch (cause) {
        return failed(cause);
      }
    },
    onResume: autofill?.onResume ?? (() => () => {}),
  };
}
