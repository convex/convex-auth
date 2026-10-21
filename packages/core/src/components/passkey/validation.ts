import { Infer, v } from "convex/values";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * Constants used for some basic best-effort validation of the
 * `transports` strings. These limits are far above the registered
 * values. They stop a client that does not obey the spec from writing
 * large data to the database.
 *
 * The WebAuthn spec gives no limit for these values, but each registered
 * transport is a short word of lowercase letters and hyphens ("usb",
 * "hybrid", "smart-card").
 */
const MAX_TRANSPORTS = 16;
const MAX_TRANSPORT_LENGTH = 32;

// The characters that a transport can contain: printable ASCII without
// the space.
const TRANSPORT_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Examine the transports that the client reports, before the component
 * stores them.
 *
 * The component does not compare the values with a list of known
 * transports, because the WebAuthn spec lets new transports appear. It
 * only refuses the values that no authenticator can report.
 */
export function transportsAreValid(values: string[] | undefined): boolean {
  if (values === undefined) return true;

  if (values.length > MAX_TRANSPORTS) return false;

  return values.every(
    (value) =>
      value.length <= MAX_TRANSPORT_LENGTH && TRANSPORT_PATTERN.test(value),
  );
}

/**
 * The largest length of a `purpose` string. A purpose names one flow of the
 * app ("myApp:signIn"), thus a short limit is enough. The limit stops a
 * caller from writing large data to a challenge row.
 */
const MAX_PURPOSE_LENGTH = 128;

// The characters that a purpose can contain: printable ASCII without the
// space. The component does not parse the value beyond this.
const PURPOSE_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Show a purpose in an error message. The value comes from the caller,
 * thus it can be long, empty, or contain characters that are not
 * printable. `JSON.stringify` puts it in quotation marks and replaces
 * these characters. A long value is cut to keep the message short.
 */
function describePurpose(value: string) {
  const shown =
    value.length > MAX_PURPOSE_LENGTH
      ? `${value.slice(0, MAX_PURPOSE_LENGTH)}…`
      : value;
  return JSON.stringify(shown);
}

/**
 * Examine the `purpose` of an authentication challenge, before the component
 * stores it or compares it.
 *
 * The component does not give the purposes a meaning: the app chooses the
 * strings. It only refuses a values that are not well formatted
 * (maximum 128 non-space printable ASCII characters).
 *
 * @throws when the value is empty, too long, or not printable ASCII.
 */
export function validatePurpose(purpose: string) {
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new Error(
      `Purpose too long: ${describePurpose(purpose)} has ${purpose.length} characters, but a purpose can have a maximum of ${MAX_PURPOSE_LENGTH}.`,
    );
  }
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error(
      `Invalid purpose: ${describePurpose(purpose)} is not a non-empty string of printable ASCII characters.`,
    );
  }
}

/**
 * One entry of `allowCredentials` or `excludeCredentials`. The WebAuthn
 * `type` field is not included, because it is always "public-key".
 */
export const credentialDescriptor = v.object({
  id: v.bytes(),
  transports: v.optional(v.array(v.string())),
});
export type CredentialDescriptor = Infer<typeof credentialDescriptor>;

//------------------------------------------------------------------------------
// The WebAuthn JSON wire format
//------------------------------------------------------------------------------
//
// The wire between the client and the method carries the spec's JSON
// shapes (https://w3c.github.io/webauthn/#dictdef-registrationresponsejson
// and friends): base64url strings for the binary fields, options assembled
// on the server by `options.ts`, and responses fed to
// `verifyRegistrationResponse` / `verifyAuthenticationResponse` unchanged.
//
// The validators are exact: they list every field the server produces or
// reads, and nothing else. A client must prune the convenience fields that
// `@simplewebauthn/browser` adds to a response (`publicKey`,
// `publicKeyAlgorithm`, `authenticatorData`, `authenticatorAttachment`)
// before it calls a mutation; the React hooks do that pruning.

/**
 * A library type with every `transports` list widened to plain strings.
 * The wire keeps the transports open because the WebAuthn spec lets new
 * transports appear, and the component stores them as free-form strings.
 * Used only by the `_…Matches` pins below.
 */
type OpenTransports<T> = T extends readonly (infer E)[]
  ? OpenTransports<E>[]
  : T extends object
    ? {
        [K in keyof T]: K extends "transports"
          ? string[]
          : OpenTransports<T[K]>;
      }
    : T;

/** Require `A` to be assignable to `B` (used as a compile-time pin). */
type Extends<A extends B, B> = A;

/** The JSON form of {@link credentialDescriptor}, for the options objects. */
const credentialDescriptorJSON = v.object({
  id: v.string(),
  type: v.literal("public-key"),
  transports: v.optional(v.array(v.string())),
});

/**
 * The `PublicKeyCredentialCreationOptionsJSON` that the start mutations of a
 * registration ceremony return. Pass it to the WebAuthn `create()` call
 * (for example through `startRegistration` of `@simplewebauthn/browser`).
 *
 * The shape is exactly what `generateRegistrationOptions` produces with the
 * settings of the `usernamePasskey` method: `attestation: "none"`, a discoverable
 * credential with required user verification, and no extensions.
 */
export const vPublicKeyCredentialCreationOptionsJSON = v.object({
  rp: v.object({ id: v.string(), name: v.string() }),
  user: v.object({
    id: v.string(),
    name: v.string(),
    displayName: v.string(),
  }),
  challenge: v.string(),
  pubKeyCredParams: v.array(
    v.object({ alg: v.number(), type: v.literal("public-key") }),
  ),
  timeout: v.number(),
  excludeCredentials: v.array(credentialDescriptorJSON),
  authenticatorSelection: v.object({
    residentKey: v.literal("required"),
    requireResidentKey: v.literal(true),
    userVerification: v.literal("required"),
  }),
  attestation: v.literal("none"),
  extensions: v.object({}),
});
export type WireCreationOptions = Infer<
  typeof vPublicKeyCredentialCreationOptionsJSON
>;
type _CreationOptionsMatch = Extends<
  WireCreationOptions,
  OpenTransports<PublicKeyCredentialCreationOptionsJSON>
>;

/**
 * The `PublicKeyCredentialRequestOptionsJSON` that the start mutations of an
 * authentication ceremony return. Pass it to the WebAuthn `navigator.credentials.get()` call (for
 * example through `startAuthentication` of `@simplewebauthn/browser`).
 *
 * An empty `allowCredentials` list means a discoverable-credential ceremony:
 * the passkey the user picks identifies the account.
 */
export const vPublicKeyCredentialRequestOptionsJSON = v.object({
  challenge: v.string(),
  timeout: v.number(),
  rpId: v.string(),
  allowCredentials: v.array(credentialDescriptorJSON),
  userVerification: v.literal("required"),
});
export type WireRequestOptions = Infer<
  typeof vPublicKeyCredentialRequestOptionsJSON
>;
type _RequestOptionsMatch = Extends<
  WireRequestOptions,
  OpenTransports<PublicKeyCredentialRequestOptionsJSON>
>;

/**
 * The `RegistrationResponseJSON` that the finish mutations of a registration
 * ceremony take, without the convenience fields that duplicate data from the
 * attestation object (`publicKey`, `publicKeyAlgorithm`,
 * `authenticatorData`, `authenticatorAttachment`).
 *
 * `clientExtensionResults` must be empty because the options request no
 * extensions.
 */
export const vRegistrationResponseJSON = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    attestationObject: v.string(),
    transports: v.optional(v.array(v.string())),
  }),
  clientExtensionResults: v.object({}),
  type: v.literal("public-key"),
});
export type WireRegistrationResponse = Infer<typeof vRegistrationResponseJSON>;
type _RegistrationResponseMatch = Extends<
  WireRegistrationResponse,
  OpenTransports<RegistrationResponseJSON>
>;

/**
 * The `AuthenticationResponseJSON` that the finish mutations of an
 * authentication ceremony take. `clientExtensionResults` must be empty
 * because the options request no extensions.
 */
export const vAuthenticationResponseJSON = v.object({
  id: v.string(),
  rawId: v.string(),
  response: v.object({
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    signature: v.string(),
    userHandle: v.optional(v.string()),
  }),
  clientExtensionResults: v.object({}),
  type: v.literal("public-key"),
});
export type WireAuthenticationResponse = Infer<
  typeof vAuthenticationResponseJSON
>;
type _AuthenticationResponseMatch = Extends<
  WireAuthenticationResponse,
  AuthenticationResponseJSON
>;

/**
 * The client broke the WebAuthn protocol: an unexpected origin, an
 * attestation that no parser can read, a key algorithm that the ceremony
 * never offered, an assertion that no compliant authenticator makes, and so
 * on.
 *
 * This is the HTTP 400 of the component. Most of the time the client is at
 * fault, but the same code also covers a configuration mistake of the app
 * (an `rpId` or an `origin` that does not match the page). The two are not
 * separated, exactly as a 400 does not say whether the caller wrote a bad
 * request or configured a bad base URL.
 *
 * The end user cannot correct this, so an app shows a generic message. The
 * component writes which check failed to the backend logs, and never sends
 * the details to the client.
 */
const protocolError = v.object({ error: v.literal("PROTOCOL_ERROR") });

/**
 * The user-facing errors for the registration finish functions. An app can
 * show these errors to the end user. The `error` field is a machine-readable
 * code and the discriminant of the union.
 */
export const finishRegistrationUserError = v.union(
  // The challenge is unknown, already used, or too old. The user must start
  // the ceremony again.
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
  protocolError,
);
export type FinishRegistrationUserError = Infer<
  typeof finishRegistrationUserError
>;

/**
 * The user-facing errors for `finishAuthentication`. An app can show these
 * errors to the end user.
 */
export const finishAuthenticationUserError = v.union(
  // No stored passkey has the credential ID from the assertion. The
  // authenticator still offers a passkey that the app deleted.
  v.object({ error: v.literal("UNKNOWN_CREDENTIAL") }),
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
  protocolError,
);
export type FinishAuthenticationUserError = Infer<
  typeof finishAuthenticationUserError
>;

/**
 * The largest length of a passkey name, in Unicode code points. A name is a
 * short label in a settings list ("MacBook Touch ID"); the limit stops a
 * client from writing large data to the row.
 */
export const MAX_PASSKEY_NAME_LENGTH = 50;

/**
 * Characters that make the text direction or the position of the subsequent
 * characters different, and characters that show nothing. An attacker uses
 * them to show a name that is not the name that the component stores, or to
 * make a name disappear from the settings list. The list is the list of the
 * username validator.
 *
 * The list does not contain the zero-width joiner (U+200D) and the
 * zero-width non-joiner (U+200C). These two characters are necessary to
 * write some scripts correctly, and also to write emoji sequences.
 */
const BIDI_AND_INVISIBLE_CONTROLS =
  /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

/**
 * Examine a passkey name before the component stores it.
 *
 * The component only refuses what no real label is: an empty or
 * whitespace-only string, control characters, characters that spoof how the
 * name shows, or a length over {@link MAX_PASSKEY_NAME_LENGTH} code points.
 */
export function passkeyNameIsValid(name: string): boolean {
  return (
    name.trim().length > 0 &&
    [...name].length <= MAX_PASSKEY_NAME_LENGTH &&
    // `\p{Cc}` is the whole Unicode control category: the C0 range and
    // DEL, and the C1 range (U+0080-U+009F), which a paste from a legacy
    // encoding can carry.
    !/\p{Cc}/u.test(name) &&
    !BIDI_AND_INVISIBLE_CONTROLS.test(name)
  );
}

/**
 * The name is empty, too long, or contains characters that the component
 * refuses. See {@link passkeyNameIsValid}.
 */
export const invalidNameUserError = v.object({
  error: v.literal("INVALID_NAME"),
});

/**
 * The user-facing errors for `renamePasskey`. An app can show these errors
 * to the end user.
 */
export const renamePasskeyUserError = v.union(
  // The passkey does not exist, or it is the passkey of a different user.
  v.object({ error: v.literal("PASSKEY_NOT_FOUND") }),
  invalidNameUserError,
);
export type RenamePasskeyUserError = Infer<typeof renamePasskeyUserError>;

/**
 * The user-facing errors for `deletePasskey`. An app can show these errors
 * to the end user.
 */
export const deletePasskeyUserError = v.union(
  // The passkey does not exist, or it is the passkey of a different user.
  v.object({ error: v.literal("PASSKEY_NOT_FOUND") }),
);
export type DeletePasskeyUserError = Infer<typeof deletePasskeyUserError>;

/**
 * The user-facing error when the caller of a passkey-management function is
 * not signed in. Each of those functions acts on the passkeys of the
 * caller, thus a signed-out caller has nothing to act on.
 */
export const notSignedInUserError = v.object({
  error: v.literal("NOT_SIGNED_IN"),
});
export type NotSignedInUserError = Infer<typeof notSignedInUserError>;
