/**
 * The error that `requireRecentAuthentication` throws, shared by the server
 * that throws it and the clients that recognize it. Depends only on
 * `convex/values`, so both halves can import it.
 *
 * @module
 */
import { ConvexError, type Value } from "convex/values";

/**
 * The `data` of the `ConvexError` that `requireRecentAuthentication` throws
 * when the user of the session did not prove who they are recently enough.
 */
export type ReauthenticationRequiredErrorData = {
  error: "REAUTHENTICATION_REQUIRED";
};

/**
 * The `data` of the `ConvexError` that `requireRecentAuthentication` throws
 * when the caller is not signed in.
 */
export type NotLoggedInErrorData = { error: "NOT_LOGGED_IN" };

/**
 * Whether `error` is the error that `requireRecentAuthentication` throws when
 * the user must prove who they are again. Use it on the client, where the
 * call to a Convex function rejects with this error:
 *
 * ```ts
 * import { isReauthenticationRequiredError } from "@convex-dev/auth/react";
 *
 * try {
 *   await deleteAccount();
 * } catch (error) {
 *   if (isReauthenticationRequiredError(error)) {
 *     // ask the user to re-authenticate, then try again
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 */
export function isReauthenticationRequiredError(
  error: unknown,
): error is ConvexError<ReauthenticationRequiredErrorData> {
  return (
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    (error.data as Record<string, Value>).error === "REAUTHENTICATION_REQUIRED"
  );
}
