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
 * With `--page`, a third feed, from a browser that the recorder drives:
 * {@link PageEvent}, {@link InputEvent}, {@link HttpEvent},
 * {@link SocketEvent}, {@link StorageEvent}, {@link CookieEvent},
 * {@link ConsoleEvent}, and {@link ScenarioEvent}. A {@link CallEvent} links
 * each call of a function that the page made to its {@link RunEvent}. A
 * {@link SecretEvent} stands for a token that the browser held, and a
 * {@link SecretLinkEvent} links it to the row of the server that stores its
 * hash or that it names. No event holds a token: a value that looks like one
 * is replaced by a {@link SecretRef}.
 *
 * The kinds of the browser feed came after version 1 of the format, and
 * version 1 did not change: a viewer ignores the kinds it does not know.
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
  /**
   * The name of the app: the last segment of the app directory given to
   * `record` (e.g. "react-username-password"), or `--app`. Recordings made
   * before the field existed have none.
   */
  app?: string;
  /** The URL of the deployment. */
  deploymentUrl: string;
  /** The name of the project config, e.g. "generic" or "convex-auth". */
  project: string;
  /**
   * The page that the recorder opened in a browser, with `--page`. Absent
   * when the recording has no browser feed.
   */
  page?: string;
  /** The scenario that drove the page, absent when a person drove it. */
  scenario?: string;
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
 * One step report: a line `[explorer:step] {"v":1,"source":...,"step":...}`
 * that a library writes to show the steps that the other feeds do not show.
 * A function writes it to its logs ({@link FunctionStepEvent}), such as the
 * calls of a function into components, and the page to its console
 * ({@link PageStepEvent}), such as which client code read a stored token.
 */
export type StepEvent = FunctionStepEvent | PageStepEvent;

/** A step report from the logs of a function run. */
export type FunctionStepEvent = {
  kind: "step";
  /** Where the step ran. */
  from: "function";
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

/**
 * A step report that the page logged to its console. It belongs to no run.
 * Convex Auth writes them when the page sets `__CONVEX_AUTH_REPORT_STEPS__`,
 * which the recorder does.
 */
export type PageStepEvent = {
  kind: "step";
  /** Where the step ran. */
  from: "page";
  /** `<pageId>#<n>`, numbered with the other events of the page. */
  id: string;
  time: number;
  /** Null: a step of the page has no run. */
  runId: null;
  /** The tab, e.g. "p1". */
  pageId: string;
  /** Where the code that wrote the report runs, e.g. "browser", or null. */
  runsIn: string | null;
  /**
   * The part of the code that ran the step, by its id in
   * `packages/explorer-structure`, e.g. "module:browser/sessionManager", or
   * null.
   */
  part: string | null;
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

// --- The browser feed -------------------------------------------------------

/**
 * A token, in place of its value: the `id` of the {@link SecretEvent} that
 * the recorder made when it first saw the value. The same value gets the same
 * label everywhere in one recording, and no two values share a label.
 */
export type SecretRef = { $secret: string };

/**
 * The first sighting of a token in the browser feed: an access token, a
 * refresh token, a cookie value, or any string that looks random.
 */
export type SecretEvent = {
  kind: "secret";
  /** The label, e.g. "s3", that {@link SecretRef}s carry. */
  id: string;
  time: number;
  /** "jwt" for a JSON Web Token, "opaque" for anything else. */
  type: "jwt" | "opaque";
  /** The event in which the recorder first saw the token. */
  firstSeenIn: string;
  /**
   * For a JWT: its numeric claims (`exp`, `iat`, `nbf`, in seconds) and the
   * string claims that the project config keeps. Null for an opaque token.
   */
  claims: Record<string, unknown> | null;
  /** For a JWT: `alg`, `typ`, and `kid` of its header. Null otherwise. */
  header: Record<string, unknown> | null;
};

/**
 * A token of the browser feed and a row of the server that belongs to it:
 * the row that stores the digest of the token (`via` "sha256Hex:<field>"),
 * or the row whose id a claim of a JWT holds (`via` "claim:<claim>"). The
 * recorder computes the link from the raw values and writes neither.
 */
export type SecretLinkEvent = {
  kind: "secretLink";
  /** `<secret>-><component>/<table>/<documentId>`. */
  id: string;
  /** The later of the first sighting of the secret and the commit time of the row. */
  time: number;
  /** The `id` of the {@link SecretEvent}. */
  secret: string;
  component: string;
  table: string;
  documentId: string;
  via: string;
};

/** What happened to a page of the browser. */
export type PageEvent = {
  kind: "page";
  /** `<pageId>#<n>`. */
  id: string;
  time: number;
  /** The tab, e.g. "p1". */
  pageId: string;
  /** "open", "navigated" (the main frame got a new URL), "load", or "close". */
  event: "open" | "navigated" | "load" | "close";
  /** The URL, with query values and fragment replaced (see `redactUrl`). */
  url: string;
};

/** The element of the page that an {@link InputEvent} happened on. */
export type InputTarget = {
  /** The tag, lowercase, e.g. "button". */
  tag: string;
  /** The `type` attribute of an input or button, or null. */
  type: string | null;
  id: string | null;
  name: string | null;
  autocomplete: string | null;
  /**
   * The visible text of a button or a link, at most 60 characters, or
   * null.
   */
  text: string | null;
  /** A CSS selector that found the element when it happened. */
  selector: string;
  /**
   * Where the element was in the page's viewport, in CSS pixels, when it
   * happened. Absent in recordings made before the field existed.
   */
  rect?: { x: number; y: number; width: number; height: number };
  /** The size of the page's viewport then, in CSS pixels. */
  viewport?: { width: number; height: number };
};

/**
 * What the person did in the page, seen by a listener that the recorder adds
 * to every page (the only script it injects).
 */
export type InputEvent = {
  kind: "input";
  id: string;
  time: number;
  pageId: string;
  /**
   * "click", "type" (the text of a field, once the person paused or left
   * it), "submit", or "key" (Enter or Escape).
   */
  action: "click" | "type" | "submit" | "key";
  target: InputTarget;
  /**
   * For "type": the text, when the project keeps that field (see
   * `personalKeys`); "[redacted]" otherwise; null for a password field,
   * whose text never leaves the page. For "key": the key.
   */
  value: string | null;
};

/** An HTTP request of the page and its response. */
export type HttpEvent = {
  kind: "http";
  id: string;
  /** When the page sent the request. */
  time: number;
  /** When the response finished, or null if it never did. */
  endTime: number | null;
  pageId: string;
  method: string;
  /** The URL, with query values and fragment replaced. */
  url: string;
  /** The type of the request in the browser: "document", "fetch", "xhr". */
  resourceType: string;
  /** The HTTP status, or null if the request failed. */
  status: number | null;
  /** Why the request failed, or null. */
  failure: string | null;
  /**
   * For a call of the HTTP API of the deployment (`/api/query`,
   * `/api/mutation`, `/api/action`): the function and its arguments.
   * Null for any other request, whose body the timeline does not keep.
   */
  request: { path: string; args: unknown } | null;
  /**
   * For such a call: the result (`value`) or the error, and the number of
   * lines that the function logged. Null otherwise.
   */
  response: {
    ok: boolean;
    value: unknown;
    error: string | null;
    logLineCount: number;
  } | null;
};

/**
 * A message on the sync WebSocket of the deployment, or its opening or
 * closing. Other WebSockets of the page (such as a dev server's) are not
 * recorded.
 */
export type SocketEvent = {
  kind: "socket";
  id: string;
  time: number;
  pageId: string;
  /** The socket, e.g. "p1.ws2": one per connection. */
  socketId: string;
  direction: "sent" | "received" | "open" | "close";
  /**
   * The type of the message, e.g. "Connect", "ModifyQuerySet", "Mutation",
   * "Authenticate", "Transition", "MutationResponse", "AuthError"; "open"
   * or "close" for the socket itself.
   */
  type: string;
  /**
   * The fields of the message, redacted: tokens become {@link SecretRef}s,
   * function arguments and results keep only what the project config keeps,
   * `logLines` become `logLineCount`, and timestamps in nanoseconds (`ts`,
   * `serverTs`) become decimal strings. For "open", the URL.
   */
  message: Record<string, unknown>;
};

/** A change to `localStorage` or `sessionStorage`. */
export type StorageEvent = {
  kind: "storage";
  id: string;
  time: number;
  pageId: string;
  area: "local" | "session";
  /** The origin of the storage. */
  origin: string;
  op: "set" | "remove" | "clear";
  /** The key, or null for "clear". */
  key: string | null;
  /** The new value, redacted: a {@link SecretRef} for a token. */
  value: unknown;
  /** The value it replaced, redacted, or null. */
  oldValue: unknown;
};

/**
 * A cookie of the browser that appeared, changed, or went away. The recorder
 * reads the cookies every half second, thus a cookie that lived less than
 * that can be missed.
 */
export type CookieEvent = {
  kind: "cookie";
  id: string;
  time: number;
  op: "set" | "change" | "remove";
  name: string;
  domain: string;
  path: string;
  /** The value, always as a {@link SecretRef}; null for "remove". */
  value: SecretRef | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  /** When it expires, in seconds since the epoch, or -1 for a session cookie. */
  expires: number;
};

/** An error or a warning of the page: its console, or an uncaught error. */
export type ConsoleEvent = {
  kind: "console";
  id: string;
  time: number;
  pageId: string;
  /** "error", "warning", or "uncaught". */
  level: string;
  /** The text, with secrets scrubbed. */
  text: string;
};

/** A step of the scenario that drove the page. */
export type ScenarioEvent = {
  kind: "scenario";
  id: string;
  time: number;
  /** The scenario. */
  scenario: string;
  /** The step, e.g. "sign up". */
  step: string;
  status: "start" | "end" | "error";
  /** The error, scrubbed, for "error". */
  error: string | null;
};

/**
 * One call of a function that the page made, linked to its run on the
 * server when the data allows it. For a query, one call per result that the
 * page received: the first one, and each one after the query ran again.
 */
export type CallEvent = {
  kind: "call";
  id: string;
  /**
   * When the page sent the call; for a query run again, when the page got
   * the result before.
   */
  time: number;
  /** When the page got the result. */
  endTime: number;
  pageId: string;
  /** "socket" for the sync WebSocket, "http" for the HTTP API. */
  transport: "socket" | "http";
  /** "Query", "Mutation", or "Action". */
  udfType: string;
  /** The function, e.g. "auth:signIn". */
  identifier: string;
  /** The event that sent the call: a socket or http event. */
  requestEventId: string;
  /** The event that brought the result. */
  responseEventId: string;
  /** Whether the call succeeded. */
  ok: boolean;
  /**
   * For a mutation over the socket that succeeded: its commit time, in
   * nanoseconds, from the response. The writes of its run have this `ts`.
   */
  commitTs: string | null;
  /** The number of lines that the function logged, from the response. */
  logLineCount: number | null;
  /** The run on the server, or null: see `unlinked`. */
  runId: string | null;
  /**
   * How the run was found: "commitTs" (the commit time falls in the window
   * of exactly one run of the function), or "window" (exactly one run of the
   * function, from that caller, ran between the call and its result, after
   * the clocks were aligned; when several did, the one whose number of log
   * lines matches). Null when not linked.
   */
  link: "commitTs" | "window" | null;
  /** Why the call has no run, or null when it has one. */
  unlinked: string | null;
  /**
   * When several runs fit equally and the call stays unlinked: their ids.
   * One of them is the run; the data does not say which. Empty otherwise.
   */
  candidateRunIds: string[];
};

/** An event of a timeline. */
export type TimelineEvent =
  | RecordingEvent
  | RunEvent
  | LogEvent
  | StepEvent
  | WriteEvent
  | SecretEvent
  | SecretLinkEvent
  | PageEvent
  | InputEvent
  | HttpEvent
  | SocketEvent
  | StorageEvent
  | CookieEvent
  | ConsoleEvent
  | ScenarioEvent
  | CallEvent;

/** The kinds of the browser feed. */
export const BROWSER_KINDS = [
  "secret",
  "secretLink",
  "page",
  "input",
  "http",
  "socket",
  "storage",
  "cookie",
  "console",
  "scenario",
  "call",
] as const;

/** The value that replaces a secret. */
export const REDACTED = "[redacted]";
