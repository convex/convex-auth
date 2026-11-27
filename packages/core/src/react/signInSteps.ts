/**
 * The step reports of sign-in calls (see `browser/steps.ts`): `signIn.call`
 * before a call to a sign-in function, and `signIn.return` or `signIn.throw`
 * after it. Kept apart from `browser/steps.ts` because it reads the names of
 * function references through `convex/server`.
 *
 * @module
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import type { StepDetail } from "../lib/stepFormat.ts";
import {
  clientStepReportsEnabled,
  reportClientStep,
  type ClientStepPart,
} from "../browser/steps.ts";

// The values that the library's own code writes in the `status`, `kind`, and
// `userError.error` fields of its results. `signInSteps.test.ts` checks that
// each value the library's sources define is here.

/** The statuses of the library's results. */
export const STATUSES: ReadonlySet<string> = new Set([
  "active",
  "complete",
  "error",
  "pending",
  "redirect",
]);

/** The kinds of the library's results. */
export const KINDS: ReadonlySet<string> = new Set([
  "addEmail",
  "authentication",
  "changeEmail",
  "custom",
  "existingUser",
  "idle",
  "newUser",
  "noSession",
  "query",
  "registration",
  "resend",
  "rotated",
  "signUp",
  "work",
]);

/** The `userError` codes of the library's results. */
export const ERROR_CODES: ReadonlySet<string> = new Set([
  "ACCESS_DENIED",
  "ALREADY_PENDING",
  "CEREMONY_ABORTED",
  "CHALLENGE_EXPIRED",
  "EMAIL_NOT_FOUND",
  "EMAIL_TAKEN",
  "EXPIRED",
  "INCORRECT_CODE",
  "INVALID_CHALLENGE",
  "INVALID_CODE",
  "INVALID_CREDENTIALS",
  "INVALID_EMAIL",
  "INVALID_FLOW",
  "INVALID_NAME",
  "LAST_PASSKEY",
  "MISSING_SECRET",
  "NOT_LOGGED_IN",
  "NO_PENDING_ENROLLMENT",
  "OTHER_ERROR",
  "PASSKEY_ALREADY_REGISTERED",
  "PASSKEY_NOT_FOUND",
  "PASSWORD_HAS_SURROUNDING_WHITESPACE",
  "PASSWORD_TOO_COMMON",
  "PASSWORD_TOO_LONG",
  "PASSWORD_TOO_SHORT",
  "PROTOCOL_ERROR",
  "RATE_LIMITED",
  "TOO_MANY_PASSKEYS",
  "TOO_MANY_TOTPS",
  "UNKNOWN_CREDENTIAL",
  "USERNAME_HAS_INVALID_CHARACTERS",
  "USERNAME_HAS_SURROUNDING_WHITESPACE",
  "USERNAME_INVALID",
  "USERNAME_TAKEN",
  "USERNAME_TOO_LONG",
  "USERNAME_TOO_SHORT",
  "USER_NOT_FOUND",
  "VERIFICATION_FAILED",
  "WEBAUTHN_UNSUPPORTED",
  "WRONG_USER",
]);

/** A value of a sign-in result as a report shows it: known, or "other". */
function known(value: unknown, list: ReadonlySet<string>): string | null {
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" && list.has(value) ? value : "other";
}

/**
 * The outcome of a sign-in call, from its result: `status`, `success`, `kind`,
 * and the code of the `userError`. A string the library does not return, such
 * as a value of an app's own function that `useAuthSignInApi` runs, is
 * reported as "other", so that no personal value reaches a report.
 */
export function signInOutcomeOf(result: unknown): StepDetail {
  const detail: StepDetail = {};
  if (typeof result !== "object" || result === null) {
    return detail;
  }
  const { status, success, kind, userError } = result as Record<
    string,
    unknown
  >;
  const reportedStatus = known(status, STATUSES);
  if (reportedStatus !== null) detail.status = reportedStatus;
  if (typeof success === "boolean") detail.success = success;
  const reportedKind = known(kind, KINDS);
  if (reportedKind !== null) detail.kind = reportedKind;
  if (typeof userError === "object" && userError !== null) {
    const error = known(
      (userError as Record<string, unknown>).error,
      ERROR_CODES,
    );
    if (error !== null) detail.error = error;
  }
  return detail;
}

/**
 * The name of a function reference, e.g. `auth:signInWithUsernamePassword`,
 * or null when it has none (a function handle).
 */
function functionNameOf(reference: unknown): string | null {
  try {
    return getFunctionName(
      reference as FunctionReference<"mutation" | "action">,
    );
  } catch {
    return null;
  }
}

/**
 * Run a call to a sign-in function, reporting `signIn.call` before it and
 * `signIn.return` or `signIn.throw` after it. The reports hold the name of the
 * function and the outcome of its result (see {@link signInOutcomeOf}), never
 * its arguments or the rest of its result.
 *
 * When the reports are off, this returns the promise of `call` itself.
 */
export function reportedSignInCall<Result>(
  part: ClientStepPart,
  kind: "mutation" | "action",
  reference: unknown,
  call: () => Promise<Result>,
): Promise<Result> {
  if (!clientStepReportsEnabled()) {
    return call();
  }
  return reportedCall(part, kind, reference, call);
}

async function reportedCall<Result>(
  part: ClientStepPart,
  kind: "mutation" | "action",
  reference: unknown,
  call: () => Promise<Result>,
): Promise<Result> {
  const fn = functionNameOf(reference);
  reportClientStep(part, "signIn.call", { kind, function: fn });
  let result: Result;
  try {
    result = await call();
  } catch (error) {
    reportClientStep(part, "signIn.throw", { function: fn });
    throw error;
  }
  reportClientStep(part, "signIn.return", {
    function: fn,
    ...signInOutcomeOf(result),
  });
  return result;
}
