/**
 * The format of a step report, shared by the server's reports
 * (`lib/steps.ts`) and the client's (`browser/steps.ts`). It imports nothing,
 * so that the browser modules that report steps stay free of Convex.
 *
 * @module
 */

/** The start of each line that is a step report. JSON follows it. */
export const STEP_REPORT_PREFIX = "[explorer:step] ";

/** The library that writes the reports, in the `source` field of each report. */
export const STEP_REPORT_SOURCE = "convex-auth";

/** The version of the report format, in the `v` field of each report. */
export const STEP_REPORT_VERSION = 1;

/** The fields of a step report, other than the name of the step. */
export type StepDetail = Record<string, string | number | boolean | null>;
