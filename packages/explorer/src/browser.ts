/**
 * Turns what a browser shows the recorder into events: the messages of the
 * Convex sync WebSocket, the calls of the HTTP API, storage changes, cookies,
 * and the actions of the person. Pure: `browserRecorder.ts` feeds it from
 * Playwright and the Chrome DevTools Protocol.
 *
 * Every value goes through {@link BrowserRedactor}: a token becomes a label
 * (see `secrets.ts`), a password is replaced, and any other string is kept
 * only when the project config names its key.
 *
 * Nothing here knows a library: the names that a library uses (storage keys,
 * argument names, claims) come from the project config.
 *
 * @module
 */
import {
  REDACTED,
  type CallEvent,
  type CookieEvent,
  type HttpEvent,
  type InputEvent,
  type InputTarget,
  type SocketEvent,
  type StorageEvent,
} from "./events.ts";
import { nanosOf, parseJsonLossless } from "./json.ts";
import {
  browserConfig,
  type BrowserProjectConfig,
  type ProjectConfig,
} from "./project.ts";
import {
  isConvexIdField,
  looksRandom,
  redactUrl,
  scrubText,
  SECRET_NAME,
} from "./redact.ts";
import { isJwt, type Secrets } from "./secrets.ts";

/** A field name that holds text a person must keep to themselves. */
const PASSWORD_NAME = /passw|passphrase|pin$/i;
const TOKEN_LIKE = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;
const HEX = /^[0-9a-fA-F]{32,}$/;
const CONVEX_ID = /^[0-9a-z]{31,37}$/;

/** Whether a string looks like a token: random base64, long hex, or a JWT. */
export function looksLikeToken(value: string): boolean {
  return (
    isJwt(value) ||
    HEX.test(value) ||
    (TOKEN_LIKE.test(value) && looksRandom(value))
  );
}

/** Replaces the secrets and the unknown strings of browser values. */
export class BrowserRedactor {
  private readonly config: BrowserProjectConfig;
  private readonly keep: ReadonlySet<string>;

  constructor(
    project: ProjectConfig,
    private readonly secrets: Secrets,
  ) {
    this.config = browserConfig(project);
    this.keep = new Set([
      ...this.config.safeKeys,
      ...(project.keepPersonalData ? this.config.personalKeys : []),
    ]);
  }

  /**
   * A copy of a JSON value with secrets and unknown strings replaced. `key`
   * is the name of the field that holds it, or null at the top.
   */
  value(
    value: unknown,
    key: string | null,
    time: number,
    eventId: string,
  ): unknown {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value;
    }
    if (typeof value === "string") {
      return this.string(value, key, time, eventId);
    }
    if (Array.isArray(value)) {
      return value.map((element) => this.value(element, key, time, eventId));
    }
    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, inner]) => [
          name,
          this.value(inner, name, time, eventId),
        ]),
      );
    }
    return REDACTED;
  }

  private string(
    value: string,
    key: string | null,
    time: number,
    eventId: string,
  ): unknown {
    if (key !== null && PASSWORD_NAME.test(key)) {
      return REDACTED;
    }
    if (
      looksLikeToken(value) ||
      (key !== null && SECRET_NAME.test(key) && value.length >= 8)
    ) {
      return this.secrets.ref(value, time, eventId);
    }
    if (
      CONVEX_ID.test(value) &&
      (key === null || isConvexIdField(key, value) || key === "id")
    ) {
      return value;
    }
    if (key !== null && this.keep.has(key)) {
      return scrubText(value);
    }
    return REDACTED;
  }

  /** A URL with query values labelled or replaced (see `redactUrl`). */
  url(url: string, time: number, eventId: string): string {
    if (url === "about:blank") {
      return url;
    }
    if (!/^(https?|wss?):/.test(url)) {
      return url.startsWith("data:") ? "data:" : REDACTED;
    }
    return redactUrl(url, (name, value) => {
      const replaced = this.string(value, name, time, eventId);
      return typeof replaced === "string"
        ? encodeURIComponent(replaced)
        : `[secret:${(replaced as { $secret: string }).$secret}]`;
    });
  }

  /** The value of a storage key. */
  storageValue(
    key: string,
    value: string | null,
    time: number,
    eventId: string,
  ): unknown {
    if (value === null) {
      return null;
    }
    if (
      this.config.secretStorageKeys.some((prefix) => key.startsWith(prefix))
    ) {
      return this.secrets.ref(value, time, eventId);
    }
    if (looksLikeToken(value)) {
      return this.secrets.ref(value, time, eventId);
    }
    const parsed = tryJson(value);
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      return { json: this.value(parsed, key, time, eventId) };
    }
    return this.string(value, key, time, eventId);
  }

  /** The text a person typed into a field. Null for a password field. */
  typed(target: InputTarget, value: string | null): string | null {
    if (value === null || target.type === "password") {
      return null;
    }
    const names = [target.name, target.id, target.autocomplete].filter(
      (name): name is string => name !== null,
    );
    if (
      names.some((name) => PASSWORD_NAME.test(name) || SECRET_NAME.test(name))
    ) {
      return REDACTED;
    }
    if (looksLikeToken(value)) {
      return REDACTED;
    }
    return names.some((name) => this.keep.has(name))
      ? scrubText(value)
      : REDACTED;
  }

  /** Free text, such as a console error. */
  text(text: string): string {
    return scrubText(text);
  }
}

function tryJson(text: string): unknown {
  try {
    return parseJsonLossless(text);
  } catch {
    return undefined;
  }
}

/**
 * A timestamp of the sync protocol: a base64 little-endian u64 of
 * nanoseconds, as a decimal string. Null when it is not one.
 */
export function decodeSyncTs(value: unknown): string | null {
  if (typeof value !== "string") {
    return nanosOf(value);
  }
  try {
    const binary = atob(value);
    if (binary.length !== 8) {
      return null;
    }
    let nanos = 0n;
    for (let i = 7; i >= 0; i--) {
      nanos = (nanos << 8n) | BigInt(binary.charCodeAt(i));
    }
    return nanos.toString();
  } catch {
    return null;
  }
}

function version(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const { querySet, identity, ts } = value as Record<string, unknown>;
  return { querySet, identity, ts: decodeSyncTs(ts) };
}

function logLineCount(lines: unknown): number {
  return Array.isArray(lines) ? lines.length : 0;
}

/** What the call tracker needs from a socket or HTTP message. */
type CallOpen = {
  key: string;
  udfType: string;
  identifier: string;
  eventId: string;
  time: number;
};

/**
 * Tracks the calls of a page, from the message that sends a call to the one
 * that brings its result, and makes a {@link CallEvent} for each result.
 * The run is attached later (see `calls.ts`).
 */
export class CallTracker {
  private readonly open = new Map<string, CallOpen>();
  /** Per socket and query id: the subscription and its last result. */
  private readonly queries = new Map<
    string,
    CallOpen & { last: number | null }
  >();
  private count = 0;

  constructor(private readonly pageId: string) {}

  /** A call sent. */
  sent(call: CallOpen): void {
    this.open.set(call.key, call);
  }

  /** A query added to the query set of a socket. */
  subscribed(call: CallOpen): void {
    this.queries.set(call.key, { ...call, last: null });
  }

  /**
   * A query that the server removed from the query set. The page asks for
   * the removal first, but results can still arrive until the server
   * confirms it.
   */
  removed(key: string): void {
    this.queries.delete(key);
  }

  /** The result of a call: a {@link CallEvent}, or null for an unknown call. */
  answered(
    key: string,
    result: {
      eventId: string;
      time: number;
      ok: boolean;
      commitTs: string | null;
      logLineCount: number | null;
      transport: CallEvent["transport"];
    },
  ): CallEvent | null {
    const call = this.open.get(key);
    if (call === undefined) {
      return null;
    }
    this.open.delete(key);
    return this.event(call, call.time, result);
  }

  /** A new result of a subscribed query. */
  queryResult(
    key: string,
    result: {
      eventId: string;
      time: number;
      ok: boolean;
      logLineCount: number | null;
    },
  ): CallEvent | null {
    const query = this.queries.get(key);
    if (query === undefined) {
      return null;
    }
    const start = query.last ?? query.time;
    query.last = result.time;
    return this.event(query, start, {
      ...result,
      commitTs: null,
      transport: "socket",
    });
  }

  private event(
    call: CallOpen,
    start: number,
    result: {
      eventId: string;
      time: number;
      ok: boolean;
      commitTs: string | null;
      logLineCount: number | null;
      transport: CallEvent["transport"];
    },
  ): CallEvent {
    return {
      kind: "call",
      id: `${this.pageId}.call${++this.count}`,
      time: start,
      endTime: result.time,
      pageId: this.pageId,
      transport: result.transport,
      udfType: call.udfType,
      identifier: call.identifier,
      requestEventId: call.eventId,
      responseEventId: result.eventId,
      ok: result.ok,
      commitTs: result.commitTs,
      logLineCount: result.logLineCount,
      runId: null,
      link: null,
      unlinked: "not linked yet",
      candidateRunIds: [],
    };
  }
}

/** One frame of the sync WebSocket. */
export type SocketFrame = {
  pageId: string;
  socketId: string;
  eventId: string;
  time: number;
  direction: "sent" | "received";
  payload: string;
};

/**
 * Turns the frames of the Convex sync WebSocket into events, and tracks the
 * calls they carry. One per page.
 */
export class SocketReader {
  /** The largest `serverTs - received time` seen, in ms: see {@link skew}. */
  private maxSkewSample: number | null = null;

  constructor(
    private readonly redactor: BrowserRedactor,
    private readonly calls: CallTracker,
  ) {}

  /**
   * The offset of the deployment's clock from the recorder's, in ms, at most
   * the true one: from the `serverTs` of each `Transition` and when it
   * arrived. Null before the first transition.
   */
  get skew(): number | null {
    return this.maxSkewSample;
  }

  /** The events of one frame: a socket event, and a call when one ended. */
  read(frame: SocketFrame): (SocketEvent | CallEvent)[] {
    const parsed = tryJson(frame.payload);
    const message =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const type = typeof message?.type === "string" ? message.type : "unknown";
    const { fields, calls } =
      message === null
        ? { fields: { bytes: frame.payload.length }, calls: [] }
        : this.fields(type, message, frame);
    const event: SocketEvent = {
      kind: "socket",
      id: frame.eventId,
      time: frame.time,
      pageId: frame.pageId,
      socketId: frame.socketId,
      direction: frame.direction,
      type,
      message: fields,
    };
    return [event, ...calls];
  }

  private fields(
    type: string,
    message: Record<string, unknown>,
    frame: SocketFrame,
  ): { fields: Record<string, unknown>; calls: CallEvent[] } {
    const { time, eventId, socketId } = frame;
    const redact = (value: unknown, key: string | null) =>
      this.redactor.value(value, key, time, eventId);
    const calls: CallEvent[] = [];
    switch (type) {
      case "Connect":
        return {
          fields: {
            sessionId: message.sessionId,
            connectionCount: message.connectionCount,
            lastCloseReason: message.lastCloseReason,
          },
          calls,
        };
      case "ModifyQuerySet": {
        const modifications = Array.isArray(message.modifications)
          ? message.modifications.map((raw) => {
              const modification = raw as Record<string, unknown>;
              const key = `${socketId}:q${String(modification.queryId)}`;
              if (
                modification.type === "Add" &&
                typeof modification.udfPath === "string"
              ) {
                this.calls.subscribed({
                  key,
                  udfType: "Query",
                  identifier: modification.udfPath,
                  eventId,
                  time,
                });
              }
              return {
                type: modification.type,
                queryId: modification.queryId,
                ...(modification.udfPath === undefined
                  ? {}
                  : {
                      udfPath: modification.udfPath,
                      args: redact(modification.args, null),
                    }),
              };
            })
          : [];
        return {
          fields: {
            baseVersion: message.baseVersion,
            newVersion: message.newVersion,
            modifications,
          },
          calls,
        };
      }
      case "Mutation":
      case "Action":
        if (typeof message.udfPath === "string") {
          this.calls.sent({
            key: `${socketId}:${type}:${String(message.requestId)}`,
            udfType: type,
            identifier: message.udfPath,
            eventId,
            time,
          });
        }
        return {
          fields: {
            requestId: message.requestId,
            udfPath: message.udfPath,
            ...(message.componentPath === undefined
              ? {}
              : { componentPath: message.componentPath }),
            args: redact(message.args, null),
          },
          calls,
        };
      case "Authenticate":
        return {
          fields: {
            baseVersion: message.baseVersion,
            tokenType: message.tokenType,
            value:
              typeof message.value === "string"
                ? this.redactor.value(message.value, "token", time, eventId)
                : null,
          },
          calls,
        };
      case "Transition": {
        const serverTs = nanosOf(message.serverTs);
        if (serverTs !== null) {
          const sample = Number(BigInt(serverTs) / 1_000_000n) - time;
          this.maxSkewSample =
            this.maxSkewSample === null
              ? sample
              : Math.max(this.maxSkewSample, sample);
        }
        const modifications = Array.isArray(message.modifications)
          ? message.modifications.map((raw) => {
              const modification = raw as Record<string, unknown>;
              const lines = logLineCount(modification.logLines);
              if (modification.type === "QueryRemoved") {
                this.calls.removed(
                  `${socketId}:q${String(modification.queryId)}`,
                );
              }
              if (
                modification.type === "QueryUpdated" ||
                modification.type === "QueryFailed"
              ) {
                const call = this.calls.queryResult(
                  `${socketId}:q${String(modification.queryId)}`,
                  {
                    eventId,
                    time,
                    ok: modification.type === "QueryUpdated",
                    logLineCount: lines,
                  },
                );
                if (call !== null) {
                  calls.push(call);
                }
              }
              return {
                type: modification.type,
                queryId: modification.queryId,
                ...(modification.type === "QueryUpdated"
                  ? { value: redact(modification.value, null) }
                  : {}),
                ...(modification.type === "QueryFailed"
                  ? {
                      errorMessage: this.redactor.text(
                        String(modification.errorMessage),
                      ),
                      errorData: redact(modification.errorData, null),
                    }
                  : {}),
                ...(modification.logLines === undefined
                  ? {}
                  : { logLineCount: lines }),
              };
            })
          : [];
        return {
          fields: {
            startVersion: version(message.startVersion),
            endVersion: version(message.endVersion),
            modifications,
            serverTs,
            clientClockSkew: message.clientClockSkew,
          },
          calls,
        };
      }
      case "MutationResponse":
      case "ActionResponse": {
        const ok = message.success === true;
        const commitTs = ok ? decodeSyncTs(message.ts) : null;
        const lines = logLineCount(message.logLines);
        const callType = type === "MutationResponse" ? "Mutation" : "Action";
        const call = this.calls.answered(
          `${socketId}:${callType}:${String(message.requestId)}`,
          {
            eventId,
            time,
            ok,
            commitTs,
            logLineCount: lines,
            transport: "socket",
          },
        );
        if (call !== null) {
          calls.push(call);
        }
        return {
          fields: {
            requestId: message.requestId,
            success: message.success,
            ...(ok
              ? { result: redact(message.result, null) }
              : {
                  result: this.redactor.text(String(message.result)),
                  errorData: redact(message.errorData, null),
                }),
            ...(commitTs === null ? {} : { ts: commitTs }),
            logLineCount: lines,
          },
          calls,
        };
      }
      case "AuthError":
        return {
          fields: {
            error: this.redactor.text(String(message.error)),
            baseVersion: message.baseVersion,
            authUpdateAttempted: message.authUpdateAttempted,
          },
          calls,
        };
      case "FatalError":
        return {
          fields: { error: this.redactor.text(String(message.error)) },
          calls,
        };
      default:
        // `Ping`, `Event`, and types this reader does not know: their keys
        // only.
        return {
          fields: { keys: Object.keys(message).filter((k) => k !== "type") },
          calls,
        };
    }
  }
}

/** The HTTP API paths of a deployment, by the type of function they run. */
const HTTP_API: Record<string, string> = {
  "/api/query": "Query",
  "/api/mutation": "Mutation",
  "/api/action": "Action",
};

/** A request of the page, from the browser. */
export type HttpExchange = {
  pageId: string;
  eventId: string;
  time: number;
  endTime: number | null;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failure: string | null;
  requestBody: string | null;
  responseBody: string | null;
};

/**
 * The function type of a call to the HTTP API of the deployment at
 * `deploymentUrl`, or null for any other request.
 */
export function httpApiType(url: string, deploymentUrl: string): string | null {
  try {
    const parsed = new URL(url);
    const deployment = new URL(deploymentUrl);
    if (parsed.origin !== deployment.origin) {
      return null;
    }
    return HTTP_API[parsed.pathname.replace(/\/$/, "")] ?? null;
  } catch {
    return null;
  }
}

/** The events of one HTTP exchange: an http event, and a call for the API. */
export function readHttp(
  exchange: HttpExchange,
  deploymentUrl: string,
  redactor: BrowserRedactor,
  calls: CallTracker,
): (HttpEvent | CallEvent)[] {
  const { eventId, time } = exchange;
  const udfType = httpApiType(exchange.url, deploymentUrl);
  let request: HttpEvent["request"] = null;
  let response: HttpEvent["response"] = null;
  const events: (HttpEvent | CallEvent)[] = [];
  if (udfType !== null) {
    const body = tryJson(exchange.requestBody ?? "") as
      Record<string, unknown> | undefined;
    const path = typeof body?.path === "string" ? body.path : null;
    if (path !== null) {
      request = { path, args: redactor.value(body?.args, null, time, eventId) };
      calls.sent({ key: eventId, udfType, identifier: path, eventId, time });
    }
    const result = tryJson(exchange.responseBody ?? "") as
      Record<string, unknown> | undefined;
    if (result !== undefined && exchange.endTime !== null) {
      const ok = result.status === "success";
      response = {
        ok,
        value: ok ? redactor.value(result.value, null, time, eventId) : null,
        error: ok ? null : redactor.text(String(result.errorMessage ?? "")),
        logLineCount: logLineCount(result.logLines),
      };
      const call = calls.answered(eventId, {
        eventId,
        time: exchange.endTime,
        ok,
        commitTs: null,
        logLineCount: response.logLineCount,
        transport: "http",
      });
      if (call !== null) {
        events.push(call);
      }
    }
  }
  events.unshift({
    kind: "http",
    id: eventId,
    time,
    endTime: exchange.endTime,
    pageId: exchange.pageId,
    method: exchange.method,
    url: redactor.url(exchange.url, time, eventId),
    resourceType: exchange.resourceType,
    status: exchange.status,
    failure: exchange.failure,
    request,
    response,
  });
  return events;
}

/** A change of storage, from the browser. */
export type StorageChange = {
  pageId: string;
  eventId: string;
  time: number;
  area: "local" | "session";
  origin: string;
  op: "set" | "remove" | "clear";
  key: string | null;
  value: string | null;
  oldValue: string | null;
};

export function readStorage(
  change: StorageChange,
  redactor: BrowserRedactor,
): StorageEvent {
  const { eventId, time, key } = change;
  return {
    kind: "storage",
    id: eventId,
    time,
    pageId: change.pageId,
    area: change.area,
    origin: change.origin,
    op: change.op,
    key,
    value:
      key === null
        ? null
        : redactor.storageValue(key, change.value, time, eventId),
    oldValue:
      key === null
        ? null
        : redactor.storageValue(key, change.oldValue, time, eventId),
  };
}

/** A cookie, as the browser lists it. */
export type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
};

/**
 * The events between two lists of the cookies of the browser, in the order
 * of `after`, then the removed ones.
 */
export function diffCookies(
  before: readonly Cookie[],
  after: readonly Cookie[],
  time: number,
  nextId: () => string,
  secrets: Secrets,
): CookieEvent[] {
  const key = (cookie: Cookie) =>
    `${cookie.domain}|${cookie.path}|${cookie.name}`;
  const old = new Map(before.map((cookie) => [key(cookie), cookie]));
  const events: CookieEvent[] = [];
  const event = (op: CookieEvent["op"], cookie: Cookie): CookieEvent => {
    const id = nextId();
    return {
      kind: "cookie",
      id,
      time,
      op,
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      value: op === "remove" ? null : secrets.ref(cookie.value, time, id),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      expires: cookie.expires,
    };
  };
  for (const cookie of after) {
    const previous = old.get(key(cookie));
    old.delete(key(cookie));
    if (previous === undefined) {
      events.push(event("set", cookie));
    } else if (
      previous.value !== cookie.value ||
      previous.expires !== cookie.expires
    ) {
      events.push(event("change", cookie));
    }
  }
  for (const cookie of old.values()) {
    events.push(event("remove", cookie));
  }
  return events;
}

/** What the listener in the page reports. */
export type PageInput = {
  action: InputEvent["action"];
  time: number;
  target: InputTarget;
  value: string | null;
};

export function readInput(
  input: PageInput,
  pageId: string,
  eventId: string,
  redactor: BrowserRedactor,
): InputEvent {
  return {
    kind: "input",
    id: eventId,
    time: input.time,
    pageId,
    action: input.action,
    target: {
      ...input.target,
      text:
        input.target.text === null ? null : redactor.text(input.target.text),
      selector: redactor.text(input.target.selector),
    },
    value:
      input.action === "type"
        ? redactor.typed(input.target, input.value)
        : input.action === "key"
          ? input.value
          : null,
  };
}
