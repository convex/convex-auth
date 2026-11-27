/**
 * Turns the entries of `npx convex logs --jsonl` into events.
 *
 * @module
 */
import type { FunctionStepEvent, LogEvent, RunEvent } from "./events.ts";
import { scrubText, scrubValue } from "./redact.ts";

/**
 * The start of a log line that is a step report. JSON follows it:
 * `{"v":1,"source":"<library>","step":"<name>",...}`. Any library can write
 * these lines; see the README.
 */
export const STEP_REPORT_PREFIX = "[explorer:step] ";

/**
 * An entry of `npx convex logs --jsonl`. The fields that the recorder reads;
 * see `FunctionExecutionJson` in `convex/src/cli/lib/generatedFunctionLogsApi.ts`.
 */
export type LogEntry = {
  kind: "Completion" | "Progress";
  udfType: string;
  componentPath?: string | null;
  identifier: string;
  logLines: unknown[];
  timestamp: number;
  executionTimestamp?: number;
  caller?: string;
  parentExecutionId?: string | null;
  requestId: string;
  executionId: string;
  error?: string | null;
  cachedResult?: boolean;
  usageStats?: {
    databaseWriteDocuments?: number;
    databaseReadDocuments?: number;
  };
  identityType?: string;
};

/** A line of `logLines`. */
type LogLine = {
  messages?: unknown;
  level?: unknown;
  timestamp?: unknown;
  isTruncated?: unknown;
  componentPath?: unknown;
  udfPath?: unknown;
};

/** The events of one log entry. */
export type EntryEvents = {
  /** The run, for a `Completion` entry; null for a `Progress` entry. */
  run: RunEvent | null;
  /** The log lines and step reports, in the order of the entry. */
  lines: (LogEvent | FunctionStepEvent)[];
};

/**
 * Whether a value is a log entry: an object with the fields that
 * {@link eventsFromLogEntry} needs.
 */
export function isLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    (entry.kind === "Completion" || entry.kind === "Progress") &&
    typeof entry.executionId === "string" &&
    typeof entry.identifier === "string" &&
    typeof entry.timestamp === "number" &&
    Array.isArray(entry.logLines)
  );
}

/**
 * The events of one log entry.
 *
 * `firstLine` numbers the lines of the entry from that index. An action can
 * log some lines in `Progress` entries before its `Completion` entry; give
 * the count of lines already seen for the execution.
 */
export function eventsFromLogEntry(
  entry: LogEntry,
  firstLine = 0,
): EntryEvents {
  const runId = entry.executionId;
  const componentPath = entry.componentPath ?? "";
  const lines = entry.logLines.map((line, index) =>
    eventFromLogLine(
      toLogLine(line),
      runId,
      `${runId}#${firstLine + index}`,
      componentPath,
      entry.identifier,
      entry.timestamp * 1000,
    ),
  );
  if (entry.kind !== "Completion") {
    return { run: null, lines };
  }
  const endTime = entry.timestamp * 1000;
  const run: RunEvent = {
    kind: "run",
    id: runId,
    time: (entry.executionTimestamp ?? entry.timestamp) * 1000,
    endTime,
    udfType: entry.udfType,
    componentPath,
    identifier: entry.identifier,
    caller: entry.caller ?? "",
    requestId: entry.requestId,
    parentExecutionId: entry.parentExecutionId ?? null,
    ok: entry.error === null || entry.error === undefined,
    error:
      entry.error === null || entry.error === undefined
        ? null
        : scrubText(entry.error),
    cachedResult: entry.cachedResult ?? false,
    writeCount: entry.usageStats?.databaseWriteDocuments ?? 0,
    readCount: entry.usageStats?.databaseReadDocuments ?? 0,
    identityType: entry.identityType ?? null,
  };
  return { run, lines };
}

/**
 * A line of `logLines` as an object. Older clients of the log stream get each
 * line as a string, `[LEVEL] <messages>`; the recorder asks for objects, and
 * reads a string line too.
 */
function toLogLine(line: unknown): LogLine {
  if (typeof line !== "string") {
    return (line ?? {}) as LogLine;
  }
  const match = /^\[(LOG|INFO|WARN|ERROR|DEBUG)\] ([\s\S]*)$/.exec(line);
  return match === null
    ? { messages: [line] }
    : { level: match[1], messages: [match[2]] };
}

function eventFromLogLine(
  line: LogLine,
  runId: string,
  id: string,
  entryComponentPath: string,
  entryIdentifier: string,
  fallbackTime: number,
): LogEvent | FunctionStepEvent {
  const messages = Array.isArray(line.messages)
    ? line.messages.map((message) => unquote(String(message)))
    : [];
  const time =
    typeof line.timestamp === "number" ? line.timestamp : fallbackTime;
  if (messages.length === 1) {
    const report = parseStepReport(messages[0]);
    if (report !== null) {
      return { kind: "step", from: "function", id, time, runId, ...report };
    }
  }
  return {
    kind: "log",
    id,
    time,
    runId,
    level: typeof line.level === "string" ? line.level : "LOG",
    componentPath:
      typeof line.componentPath === "string"
        ? line.componentPath
        : entryComponentPath,
    udfPath: typeof line.udfPath === "string" ? line.udfPath : entryIdentifier,
    message: scrubText(messages.join(" ")),
    isTruncated: line.isTruncated === true,
  };
}

/** The logs show a string argument of `console.log` in single quotes. */
function unquote(message: string): string {
  return message.length >= 2 && message.startsWith("'") && message.endsWith("'")
    ? message.slice(1, -1)
    : message;
}

/**
 * The fields of a step report, from the text of a log line, or null if the
 * line is not one.
 *
 * Accepts any version and any source: `v` and `source` are null when they
 * are missing or not of the right type, and a report with fields that this
 * recorder does not know keeps them in `detail`.
 */
export function parseStepReport(
  message: string,
): Pick<FunctionStepEvent, "v" | "source" | "step" | "detail"> | null {
  if (!message.startsWith(STEP_REPORT_PREFIX)) {
    return null;
  }
  let report: unknown;
  try {
    report = JSON.parse(message.slice(STEP_REPORT_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return null;
  }
  const { v, source, step, ...detail } = report as Record<string, unknown>;
  if (typeof step !== "string") {
    return null;
  }
  return {
    v: typeof v === "number" ? v : null,
    source: typeof source === "string" ? scrubText(source) : null,
    step,
    detail: scrubValue(detail) as Record<string, unknown>,
  };
}
