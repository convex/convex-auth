/**
 * Client step reports: when asked to, the client side of the library writes
 * one console line for each step of a sign-in, a reload, a refresh, or a
 * sign-out. A tool that shows these flows as they run reads the lines from
 * the console of the page (`packages/explorer` is such a tool).
 *
 * The page's requests, storage, and cookies show what the client did, but
 * not which of its code did it. The reports are the record of that.
 *
 * The reports are off by default. To turn them on, set the
 * `__CONVEX_AUTH_REPORT_STEPS__` global of the page to `true` before the
 * client runs. A tool does it in a script that it adds to the page, such as
 * Playwright's `addInitScript`:
 *
 * ```ts
 * (globalThis as Record<string, unknown>).__CONVEX_AUTH_REPORT_STEPS__ = true;
 * ```
 *
 * The global is read at each step, so the app's code does not change. When it
 * is not `true`, a step writes nothing and costs a property read and, at some
 * steps, a small object of details. The reports never change what the client
 * does.
 *
 * The lines have the format of the server's reports (see `lib/steps.ts`): the
 * prefix `[explorer:step] `, then JSON with `v`, `source`, and `step`. A
 * client report adds `runsIn: "browser"` and `part`, the id of the module
 * that ran the step in `packages/explorer-structure`, such as
 * `module:browser/sessionManager`.
 *
 * A report never holds a secret or personal data: no password, no token, no
 * token hash, no email address, and no username. It names a stored token by
 * its storage key, never by its value, and a function by its name, never by
 * its arguments or its return value.
 *
 * ## Operations
 *
 * A report also says which operation its step belongs to, when the code knows
 * it. An operation is one run of something the library does: one sign-in
 * call with the session it sets, one sign-out, one token fetch with the lock
 * and the refresh in it, one start-up of the client, one reaction to a change
 * in another tab. Such a report has three more fields:
 *
 * - `op`: the number of the operation, from a counter of the page that starts
 *   at 1 when the reports are on. Numbers only grow, and some are never
 *   reported.
 * - `opKind`: what the operation is, one of {@link ClientOpKind}.
 * - `parentOp`: the number of the operation that started this one, when there
 *   is one and the code knows it.
 *
 * An operation is known only where the code was handed it, or where the step
 * runs in the same synchronous call that started the operation (see
 * {@link withClientOp}); never by what ran last before an `await`. A step
 * whose operation is not known has none of the three fields. The numbers are
 * counters, never derived from a token, a user, or a credential.
 *
 * The reports are console lines, so while the switch is on, a monitoring tool
 * on the page that records the console carries them off-site.
 *
 * This module imports nothing from Convex or React, so the browser modules
 * that report steps stay free of both. The reports of sign-in calls, which
 * need Convex, are in `react/signInSteps.ts`.
 *
 * @module
 */
import {
  STEP_REPORT_PREFIX,
  STEP_REPORT_SOURCE,
  STEP_REPORT_VERSION,
  type StepDetail,
} from "../lib/stepFormat.ts";

/** The global of the page that turns the client step reports on. */
export const CLIENT_STEP_REPORTS_GLOBAL = "__CONVEX_AUTH_REPORT_STEPS__";

/**
 * The modules that report steps, by their id in `packages/explorer-structure`.
 */
export type ClientStepPart =
  | "module:browser/sessionManager"
  | "module:browser/storage"
  | "module:browser/mutex"
  | "module:browser/retry"
  | "module:react/index"
  | "module:react/client"
  | "module:ssr/nextjs/client";

/** The kinds of the operations that client steps belong to. */
export type ClientOpKind =
  | "init"
  | "dispose"
  | "signIn"
  | "setSession"
  | "signInPending"
  | "signOut"
  | "sessionRevoked"
  | "tokenFetch"
  | "crossTab"
  | "providerMount"
  | "providerUnmount";

/**
 * An operation of the client (see the module comment). Made by
 * {@link startClientOp} only while the reports are on; `null` stands for
 * "no operation" everywhere else.
 */
export interface ClientOp {
  readonly op: number;
  readonly kind: ClientOpKind;
  readonly parentOp: number | null;
}

let lastOp = 0;

/** The operation whose synchronous call is running, set by {@link withClientOp}. */
let currentOp: ClientOp | null = null;

/**
 * Operations by an object that one of their steps returned, such as the token
 * bundle of a sign-in result, for the code that is later handed that very
 * object (see {@link linkClientOp}).
 */
const opsByObject = new WeakMap<object, ClientOp>();

/** Whether the page asked for client step reports. */
export function clientStepReportsEnabled(): boolean {
  return (
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] === true
  );
}

/**
 * Start an operation, or return `null` when the reports are off. Its parent
 * is `parent` when given, otherwise the operation whose synchronous call is
 * running (see {@link withClientOp}), if any.
 */
export function startClientOp(
  kind: ClientOpKind,
  parent: ClientOp | null = null,
): ClientOp | null {
  if (!clientStepReportsEnabled()) {
    return null;
  }
  lastOp += 1;
  return { op: lastOp, kind, parentOp: (parent ?? currentOp)?.op ?? null };
}

/**
 * Run `fn` as part of `op`: the steps that run synchronously inside it, and
 * the operations it starts synchronously, belong to `op` unless they are
 * given another. What `fn` does after its first `await` is outside, because
 * other code can run by then. With a `null` op this is `fn()`.
 */
export function withClientOp<Result>(
  op: ClientOp | null,
  fn: () => Result,
): Result {
  if (op === null) {
    return fn();
  }
  const outer = currentOp;
  currentOp = op;
  try {
    return fn();
  } finally {
    currentOp = outer;
  }
}

/**
 * Record that `object` came out of `op`, so that the code later handed the
 * same object can continue `op` (see {@link linkedClientOp}). It keys by the
 * object's identity and holds nothing of its contents.
 */
export function linkClientOp(object: unknown, op: ClientOp | null): void {
  if (op !== null && typeof object === "object" && object !== null) {
    opsByObject.set(object, op);
  }
}

/** The operation that `object` came out of, if one was recorded. */
export function linkedClientOp(object: unknown): ClientOp | null {
  if (typeof object !== "object" || object === null) {
    return null;
  }
  return opsByObject.get(object) ?? null;
}

/**
 * Write one client step report to the console, if the page asked for them.
 * The step belongs to `op` when given, otherwise to the operation whose
 * synchronous call is running (see {@link withClientOp}), if any.
 *
 * The caller gives no secret and no personal data in `detail`.
 */
export function reportClientStep(
  part: ClientStepPart,
  step: string,
  detail: StepDetail = {},
  op: ClientOp | null = null,
): void {
  if (!clientStepReportsEnabled()) {
    return;
  }
  const operation = op ?? currentOp;
  console.log(
    STEP_REPORT_PREFIX +
      JSON.stringify({
        v: STEP_REPORT_VERSION,
        source: STEP_REPORT_SOURCE,
        step,
        runsIn: "browser",
        part,
        ...detail,
        ...(operation === null
          ? {}
          : {
              op: operation.op,
              opKind: operation.kind,
              ...(operation.parentOp === null
                ? {}
                : { parentOp: operation.parentOp }),
            }),
      }),
  );
}

/** Exposed for tests: restart the counter of operations. */
export function resetClientOpsForTests(): void {
  lastOp = 0;
  currentOp = null;
}
