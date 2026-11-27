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

/** Whether the page asked for client step reports. */
export function clientStepReportsEnabled(): boolean {
  return (
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] === true
  );
}

/**
 * Write one client step report to the console, if the page asked for them.
 *
 * The caller gives no secret and no personal data in `detail`.
 */
export function reportClientStep(
  part: ClientStepPart,
  step: string,
  detail: StepDetail = {},
): void {
  if (!clientStepReportsEnabled()) {
    return;
  }
  console.log(
    STEP_REPORT_PREFIX +
      JSON.stringify({
        v: STEP_REPORT_VERSION,
        source: STEP_REPORT_SOURCE,
        step,
        runsIn: "browser",
        part,
        ...detail,
      }),
  );
}
