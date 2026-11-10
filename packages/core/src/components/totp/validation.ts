import { Infer, v } from "convex/values";

/**
 * The user-facing errors for `confirmTotp` when the user has no active
 * authenticator, as in a setup recipe that gives each user a single one. A
 * recipe that lets a user add authenticators reuses
 * {@link confirmMultiTotpUserError} instead. An application can show these
 * errors to the end user. The `error` field is a machine-readable code and
 * the discriminant of the union.
 */
export const confirmSingleTotpUserError = v.union(
  // The code is not the code that the pending secret gives at this moment.
  // Usually the user typed it wrong, or the clock of their device is off.
  v.object({ error: v.literal("INCORRECT_CODE") }),
  // The user has no pending secret: `createTotp` was not called, the
  // enrollment was confirmed already, or it expired.
  v.object({ error: v.literal("NO_PENDING_ENROLLMENT") }),
);
export type ConfirmSingleTotpUserError = Infer<
  typeof confirmSingleTotpUserError
>;

/**
 * The user-facing errors for `confirmTotp`: the errors of
 * {@link confirmSingleTotpUserError}, and `TOO_MANY_TOTPS` for a user who
 * already has as many authenticators as the component allows.
 */
export const confirmMultiTotpUserError = v.union(
  confirmSingleTotpUserError,
  // The user has `MAX_TOTPS_PER_USER` active secrets. The user deletes one
  // first.
  v.object({ error: v.literal("TOO_MANY_TOTPS") }),
);
export type ConfirmMultiTotpUserError = Infer<typeof confirmMultiTotpUserError>;

/**
 * Normalize a TOTP code as the user typed it. Authenticator apps show the
 * code with a space in the middle (`123 456`), and a user copies that space.
 */
export function normalizeCode(code: string): string {
  return code.replace(/\s/g, "");
}

/**
 * Tell if a normalized code has the form of a TOTP code with this many digits.
 */
export function isWellFormedCode(code: string, digits: number): boolean {
  return new RegExp(`^[0-9]{${digits}}$`).test(code);
}
