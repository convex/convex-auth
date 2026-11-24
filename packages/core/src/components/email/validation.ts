/**
 * The validators, the error unions and the address helpers of the email
 * component. The function files and the recipe import it.
 *
 * @module
 */

import { Infer, v } from "convex/values";

// The component applies only loose format rules: it rejects strings that can
// not be a deliverable address (or that the email sender rejects), and
// nothing more. Real ownership of the
// address is proven by the challenge, not by format checks.

// The longest address SMTP can deliver to (RFC 5321: 256 octets for the path,
// minus the angle brackets).
export const MAX_EMAIL_LENGTH = 254;

// One "@" with a non-empty local part, and a domain with at least one dot.
// Intentionally permissive: stricter patterns reject addresses that exist.
//
// The address must also be printable ASCII (thus without whitespace), and
// the domain must be a name, not an IP literal like `[127.0.0.1]`. Resend
// rejects the other addresses, and it sends the queued emails in batches:
// one rejected address makes the whole batch fail, including the emails of
// other users.
// TODO: accept internationalized domains by encoding them to Punycode.
const EMAIL_PATTERN = /^[^@]+@[^@[\]]+\.[^@]+$/;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

/**
 * The user-facing error for a malformed email address. An application can
 * show this error to the end user. The `error` field is a machine-readable
 * code and the discriminant of the union.
 */
export const emailFormatUserError = v.object({
  error: v.literal("INVALID_EMAIL"),
});
export type EmailFormatUserError = Infer<typeof emailFormatUserError>;

/**
 * Examine an email address against the format rules. Return an
 * `INVALID_EMAIL` user error for a malformed address, or `null` when the
 * address is acceptable.
 */
export function validateEmailFormat(
  email: string,
): EmailFormatUserError | null {
  if (
    email.length > MAX_EMAIL_LENGTH ||
    !PRINTABLE_ASCII.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    return { error: "INVALID_EMAIL" };
  }
  return null;
}

/**
 * The user-facing errors for the `start` mutations. An application can show
 * these errors to the end user.
 */
export const startChallengeUserError = v.union(
  emailFormatUserError,
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type StartChallengeUserError = Infer<typeof startChallengeUserError>;

/**
 * Another user has already verified this address. Only the kinds that record
 * the address for a user (`addEmail`, `changeEmail`, `signUp`) return this
 * error.
 */
export const emailTakenUserError = v.object({
  error: v.literal("EMAIL_TAKEN"),
});
export type EmailTakenUserError = Infer<typeof emailTakenUserError>;

/**
 * The user-facing errors for the `start` mutations of the kinds that record
 * the address for a user: the shared errors, plus `EMAIL_TAKEN`.
 */
export const startFreeAddressUserError = v.union(
  startChallengeUserError,
  emailTakenUserError,
);
export type StartFreeAddressUserError = Infer<typeof startFreeAddressUserError>;

/**
 * The user-facing errors for the `complete` mutations of the component.
 *
 * `INVALID_CHALLENGE` means that there is no live challenge for the secret.
 * The challenge may have expired, may already have been used, may never
 * have existed, or may have had too many incorrect short codes. The server
 * cannot tell these apart, and the user action is the same, start again.
 *
 * `INCORRECT_CODE` means that the challenge exists but the code does not
 * match. For a link, the link is not the newest one this browser started,
 * and the user must open the newest email. For a short code, it is a typo,
 * and `attemptsLeft` tells how many more codes the challenge accepts. At
 * `0`, the challenge is gone, and the user must start again.
 *
 * `RATE_LIMITED` occurs only for a short code: the address got too many
 * incorrect codes recently. The challenge stays, and the user can try again
 * after `retryAfterMs`.
 *
 * A method that sends only links gives {@link completeLinkUserError}, and a
 * method that sends only short codes gives
 * {@link completeShortCodeUserError}. {@link toLinkUserError} and
 * {@link toShortCodeUserError} narrow this error to these types.
 */
export const completeChallengeUserError = v.union(
  v.object({ error: v.literal("INVALID_CHALLENGE") }),
  v.object({
    error: v.literal("INCORRECT_CODE"),
    attemptsLeft: v.optional(v.number()),
  }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type CompleteChallengeUserError = Infer<
  typeof completeChallengeUserError
>;

/** The `complete` errors of a link challenge. */
export const completeLinkUserError = v.union(
  v.object({ error: v.literal("INVALID_CHALLENGE") }),
  v.object({ error: v.literal("INCORRECT_CODE") }),
);
export type CompleteLinkUserError = Infer<typeof completeLinkUserError>;

/** The `complete` errors of a short-code challenge. */
export const completeShortCodeUserError = v.union(
  v.object({ error: v.literal("INVALID_CHALLENGE") }),
  v.object({ error: v.literal("INCORRECT_CODE"), attemptsLeft: v.number() }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type CompleteShortCodeUserError = Infer<
  typeof completeShortCodeUserError
>;

/**
 * Narrow the error of a link challenge. A link challenge never gives
 * `RATE_LIMITED` or `attemptsLeft`, thus they throw: they are a bug.
 * Other errors (for example `EMAIL_TAKEN`) stay as they are.
 */
export function toLinkUserError<E extends { error: string }>(
  userError: E,
):
  | Exclude<E, { error: "RATE_LIMITED" | "INCORRECT_CODE" }>
  | {
      error: "INCORRECT_CODE";
    } {
  if (userError.error === "RATE_LIMITED" || "attemptsLeft" in userError) {
    throw new Error(
      `Unexpected short-code error for a link challenge: ${userError.error}`,
    );
  }
  return userError as never;
}

/**
 * Narrow the error of a short-code challenge: `INCORRECT_CODE` always has
 * `attemptsLeft`. Other errors stay as they are.
 */
export function toShortCodeUserError<E extends { error: string }>(
  userError: E,
):
  | Exclude<E, { error: "INCORRECT_CODE" }>
  | {
      error: "INCORRECT_CODE";
      attemptsLeft: number;
    } {
  if (userError.error === "INCORRECT_CODE" && !("attemptsLeft" in userError)) {
    throw new Error(
      "Unexpected link error for a short-code challenge: INCORRECT_CODE " +
        "without attemptsLeft",
    );
  }
  return userError as never;
}

/**
 * The challenge is for another user than the caller. For example, a user
 * starts a flow, signs out, and another user signs in in the same browser.
 * The challenge stays: the user must sign in with the account that started
 * the flow, and open the link again. Only the kinds that take a user return
 * this error (`addEmail`, `changeEmail`, and `custom`).
 */
export const wrongUserUserError = v.object({
  error: v.literal("WRONG_USER"),
});
export type WrongUserUserError = Infer<typeof wrongUserUserError>;

/**
 * The user-facing errors for the `complete` mutations of the kinds that
 * record the address for a user: the shared errors, plus `EMAIL_TAKEN` when
 * another user verified the address after the flow started.
 */
export const completeFreeAddressUserError = v.union(
  completeChallengeUserError,
  emailTakenUserError,
);
export type CompleteFreeAddressUserError = Infer<
  typeof completeFreeAddressUserError
>;

/** {@link completeFreeAddressUserError}, for a link challenge. */
export const completeFreeAddressLinkUserError = v.union(
  completeLinkUserError,
  emailTakenUserError,
);

/** No user has verified this address. */
export const emailNotFoundUserError = v.object({
  error: v.literal("EMAIL_NOT_FOUND"),
});
export type EmailNotFoundUserError = Infer<typeof emailNotFoundUserError>;

/**
 * The result of `lookupEmail`: the user that the address identifies, and the
 * stored form of the address. `RATE_LIMITED` means that the client IP has
 * done too many lookups.
 */
export const lookupEmailResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    // The address as the user verified it. It is the address that matched
    // the argument, not the primary address of the user. It can differ from
    // the argument in case or in Unicode form.
    storedEmail: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      emailNotFoundUserError,
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
    ),
  }),
);
export type LookupEmailResult = Infer<typeof lookupEmailResult>;

/**
 * How the `start` mutations send their email. The caller (the sign-in method)
 * resolves the function handle and the runtime options; the component only
 * calls the handle.
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component's `lib.sendEmail` mutation.
 *
 * TODO: consider supporting other email providers.
 * TODO: let applications customize the email templates.
 */
export const vEmailSenderConfig = v.object({
  kind: v.literal("resend"),
  // Function handle for the Resend component's `lib.sendEmail` mutation.
  sendEmailHandle: v.string(),
  // The From address, e.g. `"My App <auth@example.com>"`.
  from: v.string(),
  // Runtime options that `lib.sendEmail` requires.
  apiKey: v.string(),
  initialBackoffMs: v.number(),
  retryAttempts: v.number(),
});
export type EmailSenderConfig = Infer<typeof vEmailSenderConfig>;

/**
 * Normalize an email address for storage and comparisons.
 *
 * The function first makes the address lowercase, so that lookups are not
 * case-sensitive. Then it applies NFC normalization, so that two inputs that
 * a user sees as the same but that use different Unicode normalization forms
 * compare as equal. The order is important: the lowercase operation can make
 * a string that is not in the NFC form.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().normalize("NFC");

  // Note that in theory, email addresses are case-sensitive (https://stackoverflow.com/a/9808332/4652564).
  // In this project we always store the canonical email representation using the
  // case that the user used, but use a normalized lowercase version to check for existing accounts.
  //
  // This means that if Jane.Doe@example.com creates an account, we will store her email
  // as Jane.Doe@example.com (and the app will display her email using that case).
  // She will also be able to log in with jane.doe@example.com.
  // This is what we expect the correct behavior to be in practice.
  //
  // The only downside is that if jane.doe@example.com is a separate person,
  // she won’t be able to also create an account.
  // (But she won’t be able to perform account recovery to the original account,
  // as account recovery emails will be sent to Jane.Doe@example.com).
}

/**
 * Tell what is wrong with the origin of a short code, or `null` when it is
 * correct. The `OTP-Token` header (draft-goto-otp-token) requires the
 * canonical form of a potentially trustworthy origin: `https`, or `http` on
 * localhost, with a lowercase host, no default port, no path, and no
 * trailing slash.
 */
export function originProblem(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "is not an origin";
  }
  if (parsed.origin === "null") {
    return "has a scheme that has no origin";
  }
  const isLocalhost =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname.endsWith(".localhost");
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLocalhost)
  ) {
    return "is not https (http is accepted only on localhost)";
  }
  if (parsed.origin !== origin) {
    return `is not in canonical form (expected "${parsed.origin}")`;
  }
  return null;
}

/**
 * Check that a landing URL can open from an email: it is absolute and starts
 * with a scheme followed by `//` (`https://example.com/verify`, or an app
 * link such as `myapp:///verify`). Return a description of the problem, or
 * `null` when the URL is correct.
 *
 * The `//` check catches a URL that is missing its scheme, such as
 * `localhost:5173/verify`: `new URL` accepts it, with `localhost:` as the
 * scheme, but the link does not open.
 */
export function landingUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a full URL";
  }
  if (!url.trim().slice(parsed.protocol.length).startsWith("//")) {
    return `has no scheme ("${parsed.protocol}" is read as the scheme)`;
  }
  return null;
}
