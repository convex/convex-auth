/**
 * Step reports: when asked to, the app-side code of the core writes one log
 * line for each step of a sign-in, a refresh, or a sign-out. A tool that shows
 * these flows as they run reads the lines from the function logs of the
 * deployment (`packages/explorer` is such a tool).
 *
 * Convex logs one entry for each function that a client calls. The calls that
 * the function makes into the components are not in the logs, thus the reports
 * are the only record of their order.
 *
 * The reports are off by default. To turn them on, set the
 * `CONVEX_AUTH_REPORT_STEPS` environment variable of the deployment to
 * `true`:
 *
 * ```sh
 * npx convex env set CONVEX_AUTH_REPORT_STEPS true
 * ```
 *
 * A report never holds a secret or personal data: no password, no token, no
 * token hash, no email address, and no username. It holds the name of the
 * step, the names of functions and components, user ids, and result codes.
 *
 * @module
 */
import { getFunctionAddress } from "convex/server";

/** The environment variable that turns the step reports on. */
export const STEP_REPORTS_ENV = "CONVEX_AUTH_REPORT_STEPS";

/** The start of each log line that is a step report. JSON follows it. */
export const STEP_REPORT_PREFIX = "[convex-auth:step] ";

/** The version of the report format, in the `v` field of each report. */
export const STEP_REPORT_VERSION = 1;

/** The fields of a step report, other than the name of the step. */
export type StepDetail = Record<string, string | number | boolean | null>;

/**
 * Whether the deployment asked for step reports. Read at call time, so that a
 * change to the environment variable applies without a new deploy.
 */
export function stepReportsEnabled(): boolean {
  return process.env[STEP_REPORTS_ENV] === "true";
}

/**
 * Write one step report to the function logs.
 *
 * The caller checks {@link stepReportsEnabled} first, and gives no secret and
 * no personal data in `detail`.
 */
export function reportStep(step: string, detail: StepDetail = {}): void {
  console.log(
    STEP_REPORT_PREFIX +
      JSON.stringify({ v: STEP_REPORT_VERSION, step, ...detail }),
  );
}

// A result code is a short identifier, such as `INVALID_CREDENTIALS`. Free
// text does not match, thus it never reaches a report.
const RESULT_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The outcome of a function of a sign-in method, from its return value: the
 * `status` or the `success` field, and the code of the `userError`.
 *
 * Returns nothing else of the value, because the value can hold tokens.
 */
export function outcomeOf(result: unknown): StepDetail {
  const detail: StepDetail = {};
  if (typeof result !== "object" || result === null) {
    return detail;
  }
  const { status, success, kind, userError } = result as Record<
    string,
    unknown
  >;
  if (typeof status === "string" && RESULT_CODE.test(status)) {
    detail.status = status;
  }
  if (typeof success === "boolean") {
    detail.success = success;
  }
  if (typeof kind === "string" && RESULT_CODE.test(kind)) {
    detail.kind = kind;
  }
  if (typeof userError === "object" && userError !== null) {
    const { error } = userError as Record<string, unknown>;
    if (typeof error === "string" && RESULT_CODE.test(error)) {
      detail.error = error;
    }
  }
  return detail;
}

/**
 * How Convex encodes the reference of a function of a component that the app
 * mounts: `components.authPassword.public.verifyPassword` is
 * `_reference/childComponent/authPassword/public/verifyPassword`.
 */
const CHILD_COMPONENT_PREFIX = "_reference/childComponent/";

/**
 * The name of the function that a reference points at, for a report:
 * `authPassword/public/verifyPassword` for a function of a component, and
 * `users:createUser` for a function of the app.
 */
export function callTargetOf(reference: unknown): string {
  try {
    const address = getFunctionAddress(reference);
    if (typeof address.reference === "string") {
      return address.reference.startsWith(CHILD_COMPONENT_PREFIX)
        ? address.reference.slice(CHILD_COMPONENT_PREFIX.length)
        : address.reference;
    }
    if (typeof address.name === "string") {
      return address.name;
    }
    return "function handle";
  } catch {
    return "unknown";
  }
}

/** The part of a ctx that calls other functions. */
type CallingCtx = {
  runQuery: (reference: never, ...args: never[]) => Promise<unknown>;
  runMutation?: (reference: never, ...args: never[]) => Promise<unknown>;
};

async function reportedCall<Result>(
  kind: "query" | "mutation",
  reference: unknown,
  call: () => Promise<Result>,
): Promise<Result> {
  const target = callTargetOf(reference);
  reportStep("call", { kind, target });
  let result: Result;
  try {
    result = await call();
  } catch (error) {
    reportStep("throw", { target });
    throw error;
  }
  reportStep("return", { target });
  return result;
}

/**
 * A copy of `ctx` whose `runQuery` and `runMutation` report a `call` step
 * before each call into another function, and a `return` or a `throw` step
 * after it. The reports hold the name of the function, never its arguments or
 * its return value.
 */
export function withCallReports<Ctx extends CallingCtx>(ctx: Ctx): Ctx {
  const calls = ctx as unknown as Record<
    "runQuery" | "runMutation",
    (...all: unknown[]) => Promise<unknown>
  >;
  const runQuery = (reference: unknown, ...args: unknown[]) =>
    reportedCall("query", reference, () => calls.runQuery(reference, ...args));
  if (ctx.runMutation === undefined) {
    return { ...ctx, runQuery } as Ctx;
  }
  const runMutation = (reference: unknown, ...args: unknown[]) =>
    reportedCall("mutation", reference, () =>
      calls.runMutation(reference, ...args),
    );
  return { ...ctx, runQuery, runMutation } as Ctx;
}
