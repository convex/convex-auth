/**
 * The constants of the passkey component that both sides of the wire read.
 *
 * They live apart from `validation.ts` so that the browser bundle of
 * `react.tsx` does not retain the validators for them: a `v.object(...)`
 * initializer is not provably pure, so a bundler keeps every validator of a
 * module that a client imports one value from.
 *
 * @module
 */

// How long a stored challenge stays valid. The WebAuthn spec recommends
// ceremony timeouts of 5–10 minutes to leave room for user interaction
// (PIN entry, cross-device flows); we match the upper bound. Expiring
// challenges bounds the window for replay of an intercepted challenge.
// https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// The COSE signature algorithms this component accepts, as IANA identifiers
// (https://www.iana.org/assignments/cose/cose.xhtml#algorithms). The same
// list is offered to the authenticator in the server-built
// `pubKeyCredParams` and enforced when the attestation is verified, so the
// two can never disagree. `@simplewebauthn/server` also verifies Ed25519
// (-8); adding it here is the only change needed to accept it.
export const SUPPORTED_ALGORITHM_IDS = [
  -7, // ES256
  -257, // RS256
];
