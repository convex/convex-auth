/**
 * React Native client for the username-passkey method, built on
 * `react-native-passkeys`. The hooks of `react-native.tsx` run it.
 *
 * It mirrors the browser client of `client.ts`: the same
 * {@link PasskeyCeremonies} shape, the same pruned wire responses, and the
 * same {@link PasskeyClientError} codes. Only the platform calls and the
 * error names differ.
 *
 * @module
 */

import * as Passkeys from "react-native-passkeys";
import type {
  WireCreationOptions,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
import {
  pruneAuthenticationResponse,
  pruneRegistrationResponse,
  type PasskeyAuthenticationResult,
  type PasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyRegistrationResult,
} from "./ceremonies.ts";

/** The `name`, `code`, and `message` of a thrown value, when it has them. */
function errorFields(cause: unknown): {
  name?: string;
  code?: string;
  message?: string;
} {
  if (typeof cause !== "object" || cause === null) {
    return {};
  }
  const { name, code, message } = cause as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return {
    name: typeof name === "string" ? name : undefined,
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/**
 * Fold a value that `react-native-passkeys` threw into the
 * {@link PasskeyClientError} shape.
 *
 * The two platforms report failures differently:
 *
 * - iOS rejects with an Expo exception whose `name` is the exception class
 *   (`UserCancelledException`, …) and whose `code` is derived from it
 *   (`ERR_USER_CANCELLED`, …).
 * - Android rejects with the `Passkey Create` or `Passkey Get` code and
 *   puts the failure in the message: `UserCancelled`, `NoCredentials`,
 *   `NotSupported`, or `DomError: <DOMException name> - <message>`.
 *
 * The JavaScript wrapper throws a `NotSupportedError` before it calls
 * either platform when the device has no passkey support.
 */
export function foldNativeError(
  cause: unknown,
  ceremony: "create" | "get",
): PasskeyClientError {
  const { name = "", code = "", message = "" } = errorFields(cause);
  const haystack = `${name} ${code} ${message}`;

  if (/UserCancel|USER_CANCEL/.test(haystack)) {
    return { error: "CEREMONY_ABORTED" };
  }
  // No passkey of this app on the device. A browser shows its dialog and
  // the user dismisses it, which is `CEREMONY_ABORTED` there too.
  if (/NoCredentials/.test(haystack)) {
    return { error: "CEREMONY_ABORTED" };
  }
  if (/NotSupported|NOT_SUPPORTED/.test(haystack)) {
    return { error: "WEBAUTHN_UNSUPPORTED" };
  }
  if (/DomError: (NotAllowedError|AbortError)\b/.test(message)) {
    return { error: "CEREMONY_ABORTED" };
  }
  if (ceremony === "create" && /DomError: InvalidStateError\b/.test(message)) {
    return { error: "PASSKEY_ALREADY_REGISTERED" };
  }
  return { error: "OTHER_ERROR", cause };
}

/** Whether this device supports passkeys. Never throws. */
function isSupported(): boolean {
  try {
    return Passkeys.isSupported();
  } catch {
    // The native module is missing, for example in Expo Go.
    return false;
  }
}

/**
 * The transports that the iOS side of `react-native-passkeys` accepts: the
 * cases of the `AuthenticatorTransport` enum in its `ios/Shared.swift`.
 * Compare them on each upgrade of the library.
 *
 * Only the iOS code of the library constrains the transports, not iOS
 * itself. On Android, the library keeps them as plain strings and passes
 * them to Credential Manager. On the web, it passes them to
 * `navigator.credentials` unchanged, and the browser ignores the unknown
 * ones. The filter applies on every platform anyway, which costs nothing,
 * because a transport is only a hint.
 */
const KNOWN_TRANSPORTS = new Set([
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

/**
 * Drop the transports that the library does not know.
 *
 * A passkey stores the transports that its authenticator reported at
 * registration, maybe on another client, and the wire keeps them as
 * free-form strings because the WebAuthn spec lets new transports appear.
 * iOS rejects the whole call when a transport is not in its enum. A
 * transport is only a hint, thus dropping it keeps the ceremony working.
 */
// TODO: file an upstream bug for the iOS implementation to ignore unknown
// transports.
function withKnownTransports<T extends { transports?: string[] }>(
  descriptor: T,
): T {
  if (descriptor.transports === undefined) {
    return descriptor;
  }
  return {
    ...descriptor,
    transports: descriptor.transports.filter((t) => KNOWN_TRANSPORTS.has(t)),
  };
}

async function register(
  options: WireCreationOptions,
): Promise<PasskeyRegistrationResult> {
  if (!isSupported()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const response = await Passkeys.create(
      // The cast narrows the transports, which `withKnownTransports` has
      // limited to the values of the library type.
      {
        ...options,
        excludeCredentials: options.excludeCredentials.map(withKnownTransports),
      } as Parameters<typeof Passkeys.create>[0],
    );
    if (response === null) {
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return { success: true, response: pruneRegistrationResponse(response) };
  } catch (cause) {
    return { success: false, userError: foldNativeError(cause, "create") };
  }
}

async function authenticate(
  options: WireRequestOptions,
): Promise<PasskeyAuthenticationResult> {
  if (!isSupported()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const response = await Passkeys.get(
      // See the cast note in `register`.
      {
        ...options,
        allowCredentials: options.allowCredentials.map(withKnownTransports),
      } as Parameters<typeof Passkeys.get>[0],
    );
    if (response === null) {
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return { success: true, response: pruneAuthenticationResponse(response) };
  } catch (cause) {
    return { success: false, userError: foldNativeError(cause, "get") };
  }
}

/**
 * The React Native ceremonies. Autofill runs in browsers only, thus the
 * autofill flow reports `available: false` and never starts a request.
 */
export const nativeCeremonies: PasskeyCeremonies = {
  isSupported,
  register,
  authenticate,
  isAutofillAvailable: () => Promise.resolve(false),
  authenticateWithAutofill: () =>
    Promise.resolve({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    }),
  onResume: () => () => {},
};
