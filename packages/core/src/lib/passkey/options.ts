/**
 * Assembly of the WebAuthn options objects that the start mutations of the
 * method return.
 *
 * These helpers pin the settings of this method and build the exact wire
 * shape of the validators in `validation.ts`. The objects are plain data:
 * every binary field is base64url, and every other field is a constant of
 * this method or a value that a component start function supplied.
 *
 * `generateRegistrationOptions` / `generateAuthenticationOptions` of
 * `@simplewebauthn/server` build the same objects, but this module does not
 * use them. It is app-side code, which an app bundles into its own Convex
 * deployment, and the library entry points pull in the X.509 and ASN.1
 * stack (~390 KB minified). With the challenge and the user handle supplied
 * by the component, the library adds nothing here but the base64url
 * encoding that `base64url.ts` does in ten lines.
 *
 * @module
 */
import { toBase64URL } from "./base64url.ts";
import {
  CHALLENGE_TTL_MS,
  SUPPORTED_ALGORITHM_IDS,
} from "../../components/passkey/constants.ts";
import type {
  CredentialDescriptor,
  WireCreationOptions,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";

// The `timeout` hint for the browser (browsers clamp the value to their own
// maximum). It stays under the lifetime of the stored challenge, so the
// browser gives up on a ceremony before its challenge expires: a user who
// takes too long gets the browser's own "cancelled" failure rather than a
// `CHALLENGE_EXPIRED` from the server.
const CEREMONY_TIMEOUT_MS = CHALLENGE_TTL_MS - 60 * 1000;

// The settings this method pins. They are stated here once, and the
// `v.literal(...)` fields of the wire validators in `validation.ts` hold
// them to it.
//
// The created passkey is discoverable, which autofill requires, and
// requires user verification, which the server-side verification demands.
const AUTHENTICATOR_SELECTION = {
  residentKey: "required",
  requireResidentKey: true,
  userVerification: "required",
} as const satisfies WireCreationOptions["authenticatorSelection"];

/**
 * Turn the credential descriptors of a component start function into the
 * JSON descriptors of the wire.
 */
function descriptorsJSON(
  credentials: CredentialDescriptor[],
): WireRequestOptions["allowCredentials"] {
  return credentials.map(({ id, transports }) => ({
    id: toBase64URL(id),
    type: "public-key" as const,
    // The component stores the transports as free-form strings, because
    // the WebAuthn spec lets new ones appear.
    ...(transports !== undefined ? { transports } : {}),
  }));
}

/**
 * Build the `PublicKeyCredentialCreationOptionsJSON` for a registration
 * ceremony from the output of a component start function.
 *
 * `userName` and `userDisplayName` are what the browser shows for the new
 * passkey in its passkey manager.
 */
export function buildRegistrationOptions(args: {
  rpId: string;
  rpName: string;
  challenge: ArrayBuffer;
  userHandle: ArrayBuffer;
  userName: string;
  userDisplayName: string;
  excludeCredentials: CredentialDescriptor[];
}): WireCreationOptions {
  return {
    rp: { id: args.rpId, name: args.rpName },
    user: {
      id: toBase64URL(args.userHandle),
      name: args.userName,
      displayName: args.userDisplayName,
    },
    challenge: toBase64URL(args.challenge),
    // The same list the attestation verification enforces, so the two can
    // never disagree.
    pubKeyCredParams: SUPPORTED_ALGORITHM_IDS.map((alg) => ({
      alg,
      type: "public-key" as const,
    })),
    timeout: CEREMONY_TIMEOUT_MS,
    excludeCredentials: descriptorsJSON(args.excludeCredentials),
    authenticatorSelection: AUTHENTICATOR_SELECTION,
    attestation: "none",
    // This method requests no extensions. `credProps` would be the one
    // worth asking for, and its answer is constant-true under
    // `residentKey: "required"`.
    extensions: {},
  };
}

/**
 * Build the `PublicKeyCredentialRequestOptionsJSON` for an authentication
 * ceremony from the output of the component's `startAuthentication`.
 *
 * An empty `allowCredentials` list means a discoverable-credential
 * ceremony: the passkey the user picks identifies the account.
 */
export function buildAuthenticationOptions(args: {
  rpId: string;
  challenge: ArrayBuffer;
  allowCredentials: CredentialDescriptor[];
}): WireRequestOptions {
  return {
    challenge: toBase64URL(args.challenge),
    timeout: CEREMONY_TIMEOUT_MS,
    rpId: args.rpId,
    allowCredentials: descriptorsJSON(args.allowCredentials),
    userVerification: "required",
  };
}
