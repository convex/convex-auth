/**
 * Turns what the page script (`pageScript.ts`) and the page proxy
 * (`pageProxy.ts`) observe into timeline events, through the same functions
 * as the recorder that drives a browser (`browser.ts`): the same kinds, the
 * same shapes, the same redaction. Pure.
 *
 * Everything the page sends is checked field by field and dropped when it
 * does not fit: the proxy lets only this run's page send, but a page is code
 * that runs in a browser beside other sites.
 *
 * The page is `p1`: the stage's screen, across its documents. A document
 * sends its observations numbered; they are read in order.
 *
 * @module
 */
import {
  BrowserRedactor,
  CallTracker,
  diffCookies,
  readHttp,
  readInput,
  readPageStep,
  readStorage,
  SocketReader,
  type Cookie,
  type PageInput,
} from "./browser.ts";
import type { InputEvent, PageEvent, TimelineEvent } from "./events.ts";
import type { Secrets } from "./secrets.ts";

export type PageIngestOptions = {
  redactor: BrowserRedactor;
  secrets: Secrets;
  /** The deployment, to tell its HTTP API. */
  deploymentUrl: string;
  /** The origin of the app's page, through the proxy. */
  origin: string;
  emit: (events: TimelineEvent[]) => void;
  /** The clock, for tests. */
  now?: () => number;
};

/** How long a gap in a document's numbering is waited for, in ms. */
const GAP_MS = 2000;
/** The most observations one send may carry. */
const MAX_ITEMS = 5000;

const PAGE_ID = "p1";

type Item = Record<string, unknown>;

type DocumentState = {
  /** A short name of the document, for the ids of its sockets. */
  key: string;
  next: number;
  held: Map<number, Item[]>;
  since: number | null;
};

/** A cookie as a `Set-Cookie` header or the page names it. */
export type SeenCookie = Cookie;

const isString = (value: unknown): value is string => typeof value === "string";
const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const httpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return /^(https?|wss?):$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** The page and the proxy, read into events. */
export class PageIngest {
  private readonly calls = new CallTracker(PAGE_ID);
  private readonly reader: SocketReader;
  private readonly now: () => number;
  private counter = 0;
  private cookieCount = 0;
  private opened = false;
  private socketCount = 0;
  /** The page's socket number in each document, to the timeline's id. */
  private readonly sockets = new Map<string, string>();
  /** Per document: the next number to read, and the sends held for a gap. */
  private readonly documents = new Map<string, DocumentState>();
  /** The cookies known, by domain, path and name. */
  private cookies = new Map<string, Cookie>();

  constructor(private readonly options: PageIngestOptions) {
    this.reader = new SocketReader(options.redactor, this.calls);
    this.now = options.now ?? Date.now;
  }

  /** The offset of the deployment's clock, as `BrowserSession.skew`. */
  get skew(): number {
    return this.reader.skew ?? 0;
  }

  private nextId(): string {
    return `${PAGE_ID}#${++this.counter}`;
  }

  private emit(events: TimelineEvent[]): void {
    if (events.length > 0) {
      this.options.emit(events);
    }
  }

  /**
   * One send of the page script: `{ doc, seq, items }`. Returns false when
   * it is not one; nothing of it is read then.
   */
  receive(body: unknown): boolean {
    if (typeof body !== "object" || body === null) return false;
    const { doc, seq, items } = body as Record<string, unknown>;
    if (
      !isString(doc) ||
      doc.length === 0 ||
      doc.length > 64 ||
      !Number.isInteger(seq) ||
      (seq as number) < 0 ||
      !Array.isArray(items) ||
      items.length > MAX_ITEMS
    ) {
      return false;
    }
    let state = this.documents.get(doc);
    if (state === undefined) {
      state = {
        key: `d${this.documents.size + 1}`,
        next: 0,
        held: new Map(),
        since: null,
      };
      this.documents.set(doc, state);
    }
    if ((seq as number) < state.next || state.held.has(seq as number)) {
      return true;
    }
    state.held.set(
      seq as number,
      items.filter(
        (item): item is Item => typeof item === "object" && item !== null,
      ),
    );
    this.drain(state, false);
    return true;
  }

  /** Reads what a gap held too long; the proxy calls it now and then. */
  tick(): void {
    for (const state of this.documents.values()) this.drain(state, false);
  }

  /** Reads everything still held, gaps or not: the recording ends. */
  end(): void {
    for (const state of this.documents.values()) this.drain(state, true);
  }

  private drain(state: DocumentState, all: boolean): void {
    for (;;) {
      let items = state.held.get(state.next);
      if (items === undefined) {
        if (state.held.size === 0) {
          state.since = null;
          return;
        }
        state.since ??= this.now();
        if (!all && this.now() - state.since < GAP_MS) return;
        // A send was lost (the page went away while it was in flight): go on.
        state.next = Math.min(...state.held.keys());
        items = state.held.get(state.next)!;
      }
      state.held.delete(state.next);
      state.next++;
      state.since = null;
      for (const item of items) this.item(item, state);
    }
  }

  private item(item: Item, state: DocumentState): void {
    const time = finite(item.time) ?? this.now();
    try {
      switch (item.type) {
        case "document":
          if (!httpUrl(item.url)) return;
          if (!this.opened) {
            this.opened = true;
            this.page("open", item.url, time);
          }
          this.page("navigated", item.url, time);
          return;
        case "navigated":
        case "load":
          if (httpUrl(item.url)) this.page(item.type, item.url, time);
          return;
        case "input":
          this.input(item, time);
          return;
        case "step": {
          if (!isString(item.text)) return;
          const step = readPageStep(
            item.text,
            PAGE_ID,
            () => this.nextId(),
            time,
          );
          if (step !== null) this.emit([step]);
          return;
        }
        case "console":
          if (
            !isString(item.text) ||
            !["error", "warning", "uncaught"].includes(item.level as string)
          ) {
            return;
          }
          this.emit([
            {
              kind: "console",
              id: this.nextId(),
              time,
              pageId: PAGE_ID,
              level: item.level as string,
              text: this.options.redactor.text(item.text),
            },
          ]);
          return;
        case "http":
          this.http(item, time);
          return;
        case "socket":
          this.socket(item, time, state);
          return;
        case "storage":
          this.storage(item, time);
          return;
        case "cookies":
          this.pageCookies(item, time);
          return;
        default:
          return;
      }
    } catch {
      // A malformed observation: dropped.
    }
  }

  private page(event: PageEvent["event"], url: string, time: number): void {
    const id = this.nextId();
    this.emit([
      {
        kind: "page",
        id,
        time,
        pageId: PAGE_ID,
        event,
        url: this.options.redactor.url(url, time, id),
      },
    ]);
  }

  private input(item: Item, time: number): void {
    const action = item.action as InputEvent["action"];
    const target = item.target as Record<string, unknown> | null;
    if (
      !["click", "type", "submit", "key"].includes(action) ||
      typeof target !== "object" ||
      target === null ||
      !isString(target.tag) ||
      !isString(target.selector)
    ) {
      return;
    }
    const box = (value: unknown, keys: string[]) => {
      if (typeof value !== "object" || value === null) return undefined;
      const out: Record<string, number> = {};
      for (const key of keys) {
        const n = finite((value as Record<string, unknown>)[key]);
        if (n === null) return undefined;
        out[key] = n;
      }
      return out;
    };
    const rect = box(target.rect, ["x", "y", "width", "height"]);
    const viewport = box(target.viewport, ["width", "height"]);
    const input: PageInput = {
      action,
      time,
      target: {
        tag: target.tag,
        type: stringOrNull(target.type),
        id: stringOrNull(target.id),
        name: stringOrNull(target.name),
        autocomplete: stringOrNull(target.autocomplete),
        text: stringOrNull(target.text),
        selector: target.selector,
        ...(rect === undefined
          ? {}
          : { rect: rect as NonNullable<PageInput["target"]["rect"]> }),
        ...(viewport === undefined
          ? {}
          : {
              viewport: viewport as NonNullable<
                PageInput["target"]["viewport"]
              >,
            }),
      },
      value: stringOrNull(item.value),
    };
    this.emit([
      readInput(input, PAGE_ID, this.nextId(), this.options.redactor),
    ]);
  }

  private http(item: Item, time: number): void {
    if (
      !httpUrl(item.url) ||
      !isString(item.method) ||
      !["fetch", "xhr"].includes(item.resourceType as string)
    ) {
      return;
    }
    const status = finite(item.status);
    this.emit(
      readHttp(
        {
          pageId: PAGE_ID,
          eventId: this.nextId(),
          time,
          endTime: finite(item.endTime),
          method: item.method.slice(0, 16),
          url: item.url,
          resourceType: item.resourceType as string,
          status,
          failure: stringOrNull(item.failure),
          requestBody: stringOrNull(item.requestBody),
          responseBody: stringOrNull(item.responseBody),
        },
        this.options.deploymentUrl,
        this.options.redactor,
        this.calls,
      ),
    );
  }

  private socket(item: Item, time: number, state: DocumentState): void {
    const local = finite(item.socket);
    if (local === null) return;
    const key = `${state.key}:${local}`;
    const { redactor } = this.options;
    if (item.direction === "open") {
      if (!httpUrl(item.url) || this.sockets.has(key)) return;
      const socketId = `${PAGE_ID}.ws${++this.socketCount}`;
      this.sockets.set(key, socketId);
      const id = this.nextId();
      this.emit([
        {
          kind: "socket",
          id,
          time,
          pageId: PAGE_ID,
          socketId,
          direction: "open",
          type: "open",
          message: { url: redactor.url(item.url, time, id) },
        },
      ]);
      return;
    }
    const socketId = this.sockets.get(key);
    if (socketId === undefined) return;
    if (item.direction === "close") {
      this.sockets.delete(key);
      this.emit([
        {
          kind: "socket",
          id: this.nextId(),
          time,
          pageId: PAGE_ID,
          socketId,
          direction: "close",
          type: "close",
          message: {},
        },
      ]);
      return;
    }
    if (
      (item.direction === "sent" || item.direction === "received") &&
      isString(item.payload)
    ) {
      this.emit(
        this.reader.read({
          pageId: PAGE_ID,
          socketId,
          eventId: this.nextId(),
          time,
          direction: item.direction,
          payload: item.payload,
        }),
      );
    }
  }

  private storage(item: Item, time: number): void {
    const area = item.area;
    const op = item.op;
    if (
      (area !== "local" && area !== "session") ||
      (op !== "set" && op !== "remove" && op !== "clear")
    ) {
      return;
    }
    const key = op === "clear" ? null : stringOrNull(item.key);
    if (op !== "clear" && key === null) return;
    this.emit([
      readStorage(
        {
          pageId: PAGE_ID,
          eventId: this.nextId(),
          time,
          area,
          origin: this.options.origin,
          op,
          key,
          value: op === "set" ? stringOrNull(item.value) : null,
          oldValue: op === "clear" ? null : stringOrNull(item.oldValue),
        },
        this.options.redactor,
      ),
    ]);
  }

  private pageCookies(item: Item, time: number): void {
    const read = (list: unknown): Cookie[] =>
      Array.isArray(list)
        ? list.flatMap((raw): Cookie[] => {
            if (typeof raw !== "object" || raw === null) return [];
            const c = raw as Record<string, unknown>;
            if (!isString(c.name) || !isString(c.domain) || !isString(c.path))
              return [];
            return [
              {
                name: c.name,
                value: isString(c.value) ? c.value : "",
                domain: c.domain,
                path: c.path,
                expires: finite(c.expires) ?? -1,
                // The page can read no HttpOnly cookie.
                httpOnly: false,
                secure: c.secure === true,
                sameSite: isString(c.sameSite) ? c.sameSite : "Lax",
              },
            ];
          })
        : [];
    this.cookieChange(read(item.changed), read(item.deleted), time);
  }

  /**
   * Cookies that the app's server set or removed, from the `Set-Cookie`
   * headers of its responses through the proxy: `removed` are those whose
   * header expired them.
   */
  serverCookies(set: Cookie[], removed: Cookie[], time: number): void {
    this.cookieChange(set, removed, time);
  }

  private cookieChange(changed: Cookie[], deleted: Cookie[], time: number) {
    const key = (cookie: Cookie) =>
      `${cookie.domain}|${cookie.path}|${cookie.name}`;
    const before = [...this.cookies.values()];
    const after = new Map(this.cookies);
    for (const cookie of changed) {
      const known = after.get(key(cookie));
      // The page and the proxy can both see a cookie; each knows some of its
      // attributes, and their clocks round its expiry differently.
      if (
        known !== undefined &&
        known.value === cookie.value &&
        Math.abs(known.expires - cookie.expires) <= 2
      ) {
        continue;
      }
      after.set(key(cookie), {
        ...cookie,
        httpOnly: cookie.httpOnly || (known?.httpOnly ?? false),
      });
    }
    for (const cookie of deleted) after.delete(key(cookie));
    this.cookies = after;
    this.emit(
      diffCookies(
        before,
        [...after.values()],
        time,
        () => `cookie#${++this.cookieCount}`,
        this.options.secrets,
      ),
    );
  }

  /** A document the proxy served to the page: its request and response. */
  document(exchange: {
    time: number;
    endTime: number | null;
    method: string;
    url: string;
    status: number | null;
    failure: string | null;
  }): void {
    this.emit(
      readHttp(
        {
          pageId: PAGE_ID,
          eventId: this.nextId(),
          resourceType: "document",
          requestBody: null,
          responseBody: null,
          ...exchange,
        },
        this.options.deploymentUrl,
        this.options.redactor,
        this.calls,
      ),
    );
  }
}
