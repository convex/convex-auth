/**
 * The events of a timeline: what the recorder writes, one JSON object per
 * line, and what a viewer plays back.
 *
 * A timeline merges two feeds of a deployment:
 *
 * - The function logs: one {@link RunEvent} for each function that a client or
 *   the scheduler called, and one {@link LogEvent} or {@link StepEvent} for
 *   each line that it logged.
 * - The data sync: one {@link WriteEvent} for each revision of a document.
 *
 * Every event has a `time` in milliseconds since the Unix epoch. A step, a log
 * line, and a write link to their function run through `runId`, which is the
 * `id` of a {@link RunEvent}.
 *
 * @module
 */

/** The version of the timeline format, in the {@link RecordingEvent}. */
export const TIMELINE_VERSION = 1;

/** The first line of a timeline file. */
export type RecordingEvent = {
  kind: "recording";
  /** The version of the timeline format, {@link TIMELINE_VERSION}. */
  v: number;
  /** When the recorder started, in ms. */
  time: number;
  /** The URL of the deployment. */
  deploymentUrl: string;
  /** The name of the project config, e.g. "generic" or "convex-auth". */
  project: string;
};

/**
 * One execution of a function that a client, the scheduler, or another
 * function called. Calls from a mutation into the functions of a component
 * have no run of their own: the step reports of the run record them.
 */
export type RunEvent = {
  kind: "run";
  /** The execution id of Convex. */
  id: string;
  /** When the function started, in ms. */
  time: number;
  /** When the function finished, in ms. */
  endTime: number;
  /** "Query", "Mutation", "Action", or "HttpAction". */
  udfType: string;
  /** The path of the component of the function, "" for the app. */
  componentPath: string;
  /** The function within its component, e.g. "messages:send". */
  identifier: string;
  /** Who called the function, e.g. "HttpApi", "Websocket", "Scheduler". */
  caller: string;
  /** The id of the request that caused the run. */
  requestId: string;
  /** The run of the function that called this one, if it is in the logs. */
  parentExecutionId: string | null;
  /** Whether the function returned without an error. */
  ok: boolean;
  /** The error message, with secrets scrubbed, when `ok` is false. */
  error: string | null;
  /** Whether a query was answered from the cache. */
  cachedResult: boolean;
  /** The number of documents that the run wrote, from the usage stats. */
  writeCount: number;
  /** The number of documents that the run read, from the usage stats. */
  readCount: number;
  /** The kind of identity of the caller, e.g. "user", "instance_admin". */
  identityType: string | null;
};

/** One line that a function logged, other than a step report. */
export type LogEvent = {
  kind: "log";
  /** `<runId>#<n>`: the n-th line of the run, from 0. */
  id: string;
  time: number;
  runId: string;
  /** "LOG", "INFO", "WARN", "ERROR", or "DEBUG". */
  level: string;
  /** The component that logged the line, "" for the app. */
  componentPath: string;
  /**
   * The module and function that logged the line, e.g. "public.js:refresh"
   * for a line of a component function. A line of the function that the
   * entry is for has none in the logs; it gets the entry's identifier.
   */
  udfPath: string;
  /** The arguments of the `console` call, joined by spaces, secrets scrubbed. */
  message: string;
  /** Whether Convex cut the line short. */
  isTruncated: boolean;
};

/**
 * One step report: a log line `[explorer:step] {"v":1,"source":...,"step":...}`
 * that a library writes to show the steps inside a function, such as its
 * calls into components, which the logs do not show.
 */
export type StepEvent = {
  kind: "step";
  /** `<runId>#<n>`, numbered with the log lines of the run. */
  id: string;
  time: number;
  runId: string;
  /** The version of the report format, or null if the report has none. */
  v: number | null;
  /** The library that wrote the report, e.g. "convex-auth", or null. */
  source: string | null;
  /**
   * The name of the step, e.g. "call" or "return". Each source has its own
   * steps; a viewer shows the ones it does not know as they are.
   */
  step: string;
  /** The other fields of the report. */
  detail: Record<string, unknown>;
};

/** One revision of a document, from the data sync. */
export type WriteEvent = {
  kind: "write";
  /** `<component>/<table>/<documentId>@<ts>`. */
  id: string;
  /** The commit time, in ms. */
  time: number;
  /** The commit time in nanoseconds, as a decimal string (it exceeds 2^53). */
  ts: string;
  /** The path of the component of the table, "" for the app. */
  component: string;
  table: string;
  documentId: string;
  /** Whether the revision deletes the document. */
  deleted: boolean;
  /**
   * The document, with secrets replaced by {@link REDACTED}. Null for a
   * delete.
   */
  value: Record<string, unknown> | null;
  /**
   * The run whose transaction wrote the revision, or null if no run in the
   * timeline matches its commit time.
   */
  runId: string | null;
  /**
   * Whether the revision came from the initial snapshot of the data sync: the
   * state of the document when the recorder started, not a write that the
   * recorder saw happen.
   */
  snapshot: boolean;
};

/** An event of a timeline. */
export type TimelineEvent =
  RecordingEvent | RunEvent | LogEvent | StepEvent | WriteEvent;

/** The value that replaces a secret. */
export const REDACTED = "[redacted]";
