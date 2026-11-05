import { Infer, v } from "convex/values";
import { isCommonPassword } from "./commonPasswords.ts";

// Password requirements, following the NIST guidance summarized at
// https://auth.pilcrowonpaper.com/passwords: 8–100 characters, any printable
// Unicode, no leading/trailing whitespace. The password methods require 10
// characters or more for a new password (`DEFAULT_MIN_PASSWORD_LENGTH` of
// `lib/password.ts`).

/**
 * The absolute minimum length of a password. The component rejects a shorter
 * password in `setPassword` and in `verifyPassword`.
 *
 * It is lower than the minimum of the password methods (10), so that the component
 * can verify the passwords of other systems with this minimum (for example,
 * Convex Auth v1 accepts passwords of 8 characters).
 */
export const MIN_PASSWORD_LENGTH = 8;

export const MAX_PASSWORD_LENGTH = 100;

/**
 * A user-facing error about the format of a password.
 * Safe to surface to the end user.
 */
export const passwordFormatUserError = v.union(
  v.object({
    error: v.literal("PASSWORD_TOO_SHORT"),
    minimumLength: v.number(),
  }),
  v.object({
    error: v.literal("PASSWORD_TOO_LONG"),
    maximumLength: v.number(),
  }),
  v.object({ error: v.literal("PASSWORD_HAS_SURROUNDING_WHITESPACE") }),
);
export type PasswordFormatUserError = Infer<typeof passwordFormatUserError>;

/**
 * A user-facing error describing why a new password was rejected.
 * Safe to surface to the end user.
 */
export const setPasswordUserError = v.union(
  passwordFormatUserError,
  v.object({ error: v.literal("PASSWORD_TOO_COMMON") }),
);
export type SetPasswordUserError = Infer<typeof setPasswordUserError>;

/**
 * A user-facing error describing why a password *verification* was rejected.
 * Safe to surface to the end user. Adds the credential-check failures
 * (`INVALID_CREDENTIALS`, `RATE_LIMITED`) to the format errors above. Declared
 * here alongside {@link setPasswordUserError} so setup recipes can reuse it in
 * their own return validators.
 */
export const verifyPasswordUserError = v.union(
  passwordFormatUserError,
  v.object({ error: v.literal("INVALID_CREDENTIALS") }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type VerifyPasswordUserError = Infer<typeof verifyPasswordUserError>;

/**
 * Validate a password against the format requirements.
 *
 * Returns a `PasswordFormatUserError` describing the first violation, or `null` when the
 * password is valid.
 *
 * @throws If `minimumLength` is less than {@link MIN_PASSWORD_LENGTH} or more
 * than {@link MAX_PASSWORD_LENGTH}. This is an error of the caller, not of the
 * user: with a minimum above the maximum, no password could be valid.
 *
 * This doesn’t check that the password is not of the list of most commonly-used password
 * (use {@link validateNewPassword} when this check is necessary).
 */
export function validatePasswordInputFormat(
  password: string,
  minimumLength: number,
): PasswordFormatUserError | null {
  // Use a negation, so that the test also rejects `NaN`:
  // `NaN < MIN_PASSWORD_LENGTH` is false.
  if (!(
    minimumLength >= MIN_PASSWORD_LENGTH && minimumLength <= MAX_PASSWORD_LENGTH
  )) {
    throw new Error(
      `minimumLength must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}, but it is ${minimumLength}.`,
    );
  }

  // Length is measured in Unicode code points (`[...password].length`) rather
  // than UTF-16 units, so an astral character (e.g. an emoji) counts as one, per
  // NIST's "1 character" intent.
  const length = [...password].length;

  if (length < minimumLength) {
    return { error: "PASSWORD_TOO_SHORT", minimumLength };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return { error: "PASSWORD_TOO_LONG", maximumLength: MAX_PASSWORD_LENGTH };
  }
  // Reject leading/trailing whitespace. `\s` with the `u` flag matches Unicode
  // whitespace (e.g. non-breaking space, ideographic space), which a plain
  // `password.trim()` comparison would miss.
  if (/^\s|\s$/u.test(password)) {
    return { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" };
  }
  return null;
}

/**
 * Validate a new password that a user selects, for a new account or for a change of
 * password.
 *
 * This applies the format rules of
 * {@link validatePasswordInputFormat} and then rejects the most frequent
 * passwords.
 *
 * `setPassword` of the component gives the `minimumLength` of its caller. The
 * password methods give `DEFAULT_MIN_PASSWORD_LENGTH`, both here and to
 * `setPassword`.
 *
 * Returns a `SetPasswordUserError` for the first violation, or
 * `null` when the password is applicable.
 *
 * @throws If `minimumLength` is less than {@link MIN_PASSWORD_LENGTH} or more
 * than {@link MAX_PASSWORD_LENGTH}.
 */
export function validateNewPassword(
  password: string,
  minimumLength: number,
): SetPasswordUserError | null {
  const formatError = validatePasswordInputFormat(password, minimumLength);
  if (formatError !== null) {
    return formatError;
  }
  if (isCommonPassword(password)) {
    return { error: "PASSWORD_TOO_COMMON" };
  }
  return null;
}

// Normalize to NFC before hashing or verifying so that two inputs that a user
// perceives as identical but that arrive in different Unicode normalization
// forms hash the same.
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}
