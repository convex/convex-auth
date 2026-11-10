/**
 * The failures the clients of the sign-in methods fold a thrown value into, so
 * that every method reports an app's rejection of a sign-in the same way.
 *
 * @module
 */
import { ConvexError } from "convex/values";

/**
 * The app's own backend turned the sign-in down by throwing a `ConvexError`,
 * usually from its `onSignIn` or `createUser` callback. `data` is that error's
 * `data`, so the app can pass the client whatever it needs to show the user.
 */
export type RejectedError = { error: "REJECTED"; data: unknown };

/**
 * The call threw something other than a `ConvexError` (a network blip, a bug,
 * an unexpected server error). The thrown value is preserved on `cause` for
 * callers that want to inspect or log it.
 */
export type OtherError = { error: "OTHER_ERROR"; cause: unknown };

/**
 * The {@link RejectedError} for a thrown `ConvexError`, or `null` for any other
 * thrown value.
 */
export function asRejectedError(cause: unknown): RejectedError | null {
  return cause instanceof ConvexError
    ? { error: "REJECTED", data: cause.data }
    : null;
}

/**
 * Fold the value that a sign-in call threw: a `ConvexError` is the app
 * rejecting the sign-in, anything else is an {@link OtherError}.
 *
 * Use it only around calls that sign the user in, which are the ones that run
 * the app's callbacks.
 */
export function foldSignInThrow(cause: unknown): RejectedError | OtherError {
  return asRejectedError(cause) ?? { error: "OTHER_ERROR", cause };
}
