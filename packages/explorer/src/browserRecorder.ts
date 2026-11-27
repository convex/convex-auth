/**
 * Drives a Chromium with Playwright and reads it from the outside, through
 * the Chrome DevTools Protocol: the HTTP requests and the WebSocket frames
 * (`Network`), and the changes of `localStorage` and `sessionStorage`
 * (`DOMStorage`). The cookies are read every half second. The console and
 * uncaught errors come from Playwright.
 *
 * One script is injected into every page: a listener of the person's clicks,
 * typing, submits, and Enter and Escape keys, which the protocol does not
 * report. It never sends the text of a password field.
 *
 * Node-only.
 *
 * @module
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
} from "playwright-core";
import {
  BrowserRedactor,
  CallTracker,
  diffCookies,
  readHttp,
  readInput,
  readStorage,
  SocketReader,
  type Cookie,
  type HttpExchange,
  type PageInput,
} from "./browser.ts";
import type { PageEvent, TimelineEvent } from "./events.ts";
import type { Secrets } from "./secrets.ts";

export type BrowserOptions = {
  /** The URL of the app's page to open. */
  url: string;
  /** Show the window, for a person to drive. */
  headed: boolean;
  /**
   * The Chromium to run. Default: the one that Playwright installed for its
   * version (`npx playwright install chromium`), found through
   * `PLAYWRIGHT_BROWSERS_PATH` when set.
   */
  executablePath?: string;
  /**
   * A browser installed on the machine, by its Playwright channel: `chrome`,
   * `chrome-beta`, `msedge`, ... Playwright finds it where its installer puts
   * it, so nothing is downloaded. Ignored with `executablePath`.
   */
  channel?: string;
  /** The URL of the deployment, to tell its calls and its socket. */
  deploymentUrl: string;
  /**
   * A page that shows the app's page in a frame named {@link SCREEN_FRAME},
   * such as the stage of `explorer-world`. The recorder opens it instead of
   * `url` and records the frame alone, as the page: its navigations, the
   * person's actions in it, its requests, its storage and its console. What
   * the stage itself does is not recorded. The stage must be on the same
   * site as the app (`localhost` with another port), so that the app's
   * frame runs in the stage's process and its storage and cookies are those
   * of a first-party page.
   */
  stage?: string;
  /**
   * Opens the DevTools port of the browser on 127.0.0.1, for a scripted check
   * to look at the window and use it as a person would.
   */
  debugPort?: number;
  redactor: BrowserRedactor;
  secrets: Secrets;
  /** Receives the events, in the order the browser reported them. */
  emit: (events: TimelineEvent[]) => void;
};

/** The name of the frame of a stage that shows the app's page. */
export const SCREEN_FRAME = "explorer-screen";

// The listener of the person's actions. A string, not a function, because
// Playwright sends a function's source to the page, and the transform of tsx
// can add helpers to it that the page lacks. Without a stage it listens in the
// top window; with one, in the stage's frame of the app's page only.
const inputListener = (stage: boolean) => `(() => {
  const screen = window.name === ${JSON.stringify(SCREEN_FRAME)} &&
    window.parent !== window && window.parent === window.top;
  if (${stage ? "!screen" : "window.top !== window"} || window.__explorerListening) return;
  window.__explorerListening = true;
  window.addEventListener("load", () => {
    try { window.__explorerLoad(); } catch {}
  });
  const selectorOf = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 4) {
      if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let part = e.tagName.toLowerCase();
      const name = e.getAttribute("name");
      if (name) part += '[name="' + name + '"]';
      else if (e.parentElement) {
        const same = [...e.parentElement.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
      }
      parts.unshift(part);
      e = e.parentElement;
    }
    return parts.join(" > ");
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const r = el.getBoundingClientRect();
    const type = el.getAttribute("type");
    const labelled = tag === "button" || tag === "a" ||
      (tag === "input" && (type === "submit" || type === "button"));
    return {
      tag,
      type,
      id: el.id || null,
      name: el.getAttribute("name"),
      autocomplete: el.getAttribute("autocomplete"),
      text: labelled ? ((el.innerText || el.value || "").trim().slice(0, 60) || null) : null,
      selector: selectorOf(el),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  };
  const report = (action, el, value) => {
    try { window.__explorerInput({ action, time: Date.now(), target: describe(el), value }); } catch {}
  };
  const pending = new Map();
  const isField = (el) => el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  const flush = (el) => {
    if (!pending.has(el)) return;
    clearTimeout(pending.get(el));
    pending.delete(el);
    report("type", el, el.type === "password" ? null : String(el.value));
  };
  const flushAll = () => { for (const el of [...pending.keys()]) flush(el); };
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!isField(el)) return;
    clearTimeout(pending.get(el));
    pending.set(el, setTimeout(() => flush(el), 600));
  }, true);
  document.addEventListener("change", (e) => flush(e.target), true);
  document.addEventListener("focusout", (e) => flush(e.target), true);
  document.addEventListener("click", (e) => {
    flushAll();
    const t = e.target;
    if (!(t instanceof Element)) return;
    report("click", t.closest("button,a,input,select,textarea,label,[role=button]") || t, null);
  }, true);
  document.addEventListener("submit", (e) => {
    flushAll();
    if (e.target instanceof Element) report("submit", e.target, null);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    flushAll();
    if (e.target instanceof Element) report("key", e.target, e.key);
  }, true);
  window.addEventListener("pagehide", flushAll, true);
})();`;

const RECORDED_TYPES = new Set(["Document", "Fetch", "XHR"]);

/** The sync WebSocket URL of a deployment has its origin with ws(s). */
function isDeploymentSocket(url: string, deploymentUrl: string): boolean {
  try {
    const socket = new URL(url);
    const deployment = new URL(deploymentUrl);
    return (
      socket.host === deployment.host &&
      socket.protocol === deployment.protocol.replace("http", "ws")
    );
  } catch {
    return false;
  }
}

type PendingRequest = Omit<
  HttpExchange,
  "endTime" | "status" | "failure" | "responseBody"
> & {
  status: number | null;
  postData: Promise<string | null>;
};

/** A browser that the recorder drives and reads. */
export class BrowserSession {
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly readers: SocketReader[] = [];
  private pageCount = 0;
  private cookieCount = 0;
  private cookies: Cookie[] = [];
  private cookieTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  /** Resolves when the browser is gone: closed by the person or by {@link close}. */
  readonly closed: Promise<void>;

  private constructor(
    private readonly options: BrowserOptions,
    private readonly browser: Browser,
    readonly context: BrowserContext,
  ) {
    this.closed = new Promise((done) =>
      browser.on("disconnected", () => done()),
    );
  }

  /** Launches the browser and opens the page. */
  static async start(options: BrowserOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({
      headless: !options.headed,
      args:
        options.debugPort === undefined
          ? []
          : [`--remote-debugging-port=${options.debugPort}`],
      executablePath: options.executablePath,
      channel:
        options.executablePath === undefined ? options.channel : undefined,
    });
    // A window a person drives keeps the size they give it.
    const context = await browser.newContext(
      options.headed ? { viewport: null } : {},
    );
    const session = new BrowserSession(options, browser, context);
    await context.exposeBinding(
      "__explorerInput",
      (source, payload: PageInput) => {
        const pageId = session.pageIds.get(source.page);
        if (pageId !== undefined) {
          session.emit([
            readInput(
              payload,
              pageId,
              session.nextId(pageId),
              options.redactor,
            ),
          ]);
        }
      },
    );
    await context.exposeBinding("__explorerLoad", (source) => {
      const pageId = session.pageIds.get(source.page);
      if (pageId !== undefined && session.isScreen(source.frame)) {
        session.pageEvent(pageId, "load", source.frame.url());
      }
    });
    await context.addInitScript(inputListener(options.stage !== undefined));
    context.on("page", (page) => void session.attach(page));
    session.cookieTimer = setInterval(() => void session.readCookies(), 500);
    const page = await context.newPage();
    await session.attach(page);
    await page.goto(options.stage ?? options.url);
    return session;
  }

  /** The first page. */
  get page(): Page {
    return this.context.pages()[0];
  }

  /**
   * The frame of the app's page: the main frame of the first page, or on a
   * stage, its screen frame once it is there.
   */
  screen(): Promise<Frame> {
    const page = this.page;
    if (this.options.stage === undefined) {
      return Promise.resolve(page.mainFrame());
    }
    const found = () => page.frames().find((frame) => this.isScreen(frame));
    return new Promise((resolve, reject) => {
      const now = found();
      if (now !== undefined) return resolve(now);
      const timer = setTimeout(() => {
        page.off("frameattached", check);
        page.off("framenavigated", check);
        reject(
          new Error(`The stage showed no frame named ${SCREEN_FRAME} in 60 s.`),
        );
      }, 60_000);
      const check = () => {
        const frame = found();
        if (frame === undefined) return;
        clearTimeout(timer);
        page.off("frameattached", check);
        page.off("framenavigated", check);
        resolve(frame);
      };
      page.on("frameattached", check);
      page.on("framenavigated", check);
    });
  }

  /**
   * The offset of the deployment's clock from the recorder's, in ms, as the
   * sockets show it (see `SocketReader.skew`); 0 before the first message.
   */
  get skew(): number {
    const samples = this.readers
      .map((reader) => reader.skew)
      .filter((skew): skew is number => skew !== null);
    return samples.length === 0 ? 0 : Math.max(...samples);
  }

  async close(): Promise<void> {
    if (this.closing) {
      return this.closed;
    }
    this.closing = true;
    if (this.cookieTimer !== null) {
      clearInterval(this.cookieTimer);
    }
    await this.readCookies().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  private emit(events: TimelineEvent[]): void {
    if (events.length > 0) {
      this.options.emit(events);
    }
  }

  private counters = new Map<string, number>();
  private nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}#${n}`;
  }

  /** Whether a frame is the one recorded: the main frame, or the stage's screen. */
  isScreen(frame: Frame): boolean {
    if (this.options.stage === undefined) {
      return frame === frame.page().mainFrame();
    }
    return (
      frame.name() === SCREEN_FRAME &&
      frame.parentFrame() === frame.page().mainFrame()
    );
  }

  /** Whether a URL is of the app's page, by origin. */
  private ofApp(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.options.url).origin;
    } catch {
      return false;
    }
  }

  pageEvent(pageId: string, event: PageEvent["event"], url: string): void {
    const id = this.nextId(pageId);
    const time = Date.now();
    this.emit([
      {
        kind: "page",
        id,
        time,
        pageId,
        event,
        url: this.options.redactor.url(url, time, id),
      },
    ]);
  }

  private async attach(page: Page): Promise<void> {
    if (this.pageIds.has(page)) {
      return;
    }
    const pageId = `p${++this.pageCount}`;
    this.pageIds.set(page, pageId);
    const { redactor, deploymentUrl } = this.options;
    const calls = new CallTracker(pageId);
    const reader = new SocketReader(redactor, calls);
    this.readers.push(reader);

    const stage = this.options.stage !== undefined;
    let opened = false;
    let lastUrl = page.url();
    if (!stage) {
      this.pageEvent(pageId, "open", page.url());
      opened = true;
    }
    page.on("framenavigated", (frame) => {
      if (!this.isScreen(frame)) {
        return;
      }
      lastUrl = frame.url();
      if (!opened) {
        // On a stage the page opens when its frame first gets a URL.
        opened = true;
        this.pageEvent(pageId, "open", frame.url());
      }
      this.pageEvent(pageId, "navigated", frame.url());
    });
    if (!stage) {
      // On a stage, the listener reports the load of the frame.
      page.on("load", () => this.pageEvent(pageId, "load", page.url()));
    }
    page.on("close", () => {
      if (opened) {
        this.pageEvent(pageId, "close", stage ? lastUrl : page.url());
      }
    });
    page.on("console", (message) => {
      // On a stage, only what the app's scripts logged.
      if (stage && !this.ofApp(message.location().url)) {
        return;
      }
      const type = message.type();
      if (type === "error" || type === "warning") {
        this.emit([
          {
            kind: "console",
            id: this.nextId(pageId),
            time: Date.now(),
            pageId,
            level: type,
            text: redactor.text(message.text()),
          },
        ]);
      }
    });
    page.on("pageerror", (error) => {
      if (
        stage &&
        !this.ofApp(/https?:\/\/[^\s/]+/.exec(error.stack ?? "")?.[0] ?? "")
      ) {
        return;
      }
      this.emit([
        {
          kind: "console",
          id: this.nextId(pageId),
          time: Date.now(),
          pageId,
          level: "uncaught",
          text: redactor.text(String(error.stack ?? error.message)),
        },
      ]);
    });

    const cdp = await this.context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("DOMStorage.enable");
    this.readNetwork(cdp, pageId, calls, reader, deploymentUrl);
    this.readStorage(cdp, pageId);
  }

  private readNetwork(
    cdp: CDPSession,
    pageId: string,
    calls: CallTracker,
    reader: SocketReader,
    deploymentUrl: string,
  ): void {
    const { redactor } = this.options;
    // The protocol stamps events with a monotonic clock, in seconds; each
    // request also gives the wall time, which maps one to the other.
    let wallOffset: number | null = null;
    const wall = (timestamp: number) =>
      wallOffset === null ? Date.now() : timestamp * 1000 + wallOffset;
    const requests = new Map<string, PendingRequest>();
    const sockets = new Map<string, string>();
    let socketCount = 0;
    // On a stage, the requests of the app's frame only: the frame is known by
    // the first document of the app's origin that a frame other than the main
    // one loads, and keeps its id across its navigations.
    const stage = this.options.stage !== undefined;
    let mainFrameId: string | null = null;
    let screenFrameId: string | null = null;
    if (stage) {
      void cdp
        .send("Page.getFrameTree")
        .then(({ frameTree }) => (mainFrameId = frameTree.frame.id))
        .catch(() => {});
    }
    const recorded = (event: {
      frameId?: string;
      type?: string;
      request: { url: string };
    }) => {
      if (!stage) {
        return true;
      }
      if (
        screenFrameId === null &&
        event.type === "Document" &&
        event.frameId !== undefined &&
        event.frameId !== mainFrameId &&
        mainFrameId !== null &&
        this.ofApp(event.request.url)
      ) {
        screenFrameId = event.frameId;
      }
      return screenFrameId !== null && event.frameId === screenFrameId;
    };

    cdp.on("Network.requestWillBeSent", (event) => {
      wallOffset = event.wallTime * 1000 - event.timestamp * 1000;
      if (!RECORDED_TYPES.has(event.type ?? "") || !recorded(event)) {
        return;
      }
      const { request } = event;
      requests.set(event.requestId, {
        pageId,
        eventId: this.nextId(pageId),
        time: wall(event.timestamp),
        method: request.method,
        url: request.url,
        resourceType: (event.type ?? "other").toLowerCase(),
        status: null,
        requestBody: null,
        postData:
          request.postData !== undefined
            ? Promise.resolve(request.postData)
            : request.hasPostData === true
              ? cdp
                  .send("Network.getRequestPostData", {
                    requestId: event.requestId,
                  })
                  .then((data) => data.postData)
                  .catch(() => null)
              : Promise.resolve(null),
      });
    });
    cdp.on("Network.responseReceived", (event) => {
      const request = requests.get(event.requestId);
      if (request !== undefined) {
        request.status = event.response.status;
      }
    });
    const finish = async (
      requestId: string,
      endTime: number,
      failure: string | null,
    ) => {
      const request = requests.get(requestId);
      if (request === undefined) {
        return;
      }
      requests.delete(requestId);
      let responseBody: string | null = null;
      if (failure === null && request.resourceType !== "document") {
        responseBody = await cdp
          .send("Network.getResponseBody", { requestId })
          .then((body) =>
            body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body,
          )
          .catch(() => null);
      }
      const { postData, ...rest } = request;
      this.emit(
        readHttp(
          {
            ...rest,
            requestBody: await postData,
            endTime,
            failure,
            status: failure === null ? request.status : null,
            responseBody,
          },
          deploymentUrl,
          redactor,
          calls,
        ),
      );
    };
    cdp.on("Network.loadingFinished", (event) => {
      void finish(event.requestId, wall(event.timestamp), null);
    });
    cdp.on("Network.loadingFailed", (event) => {
      void finish(event.requestId, wall(event.timestamp), event.errorText);
    });

    cdp.on("Network.webSocketCreated", (event) => {
      if (!isDeploymentSocket(event.url, deploymentUrl)) {
        return;
      }
      const socketId = `${pageId}.ws${++socketCount}`;
      sockets.set(event.requestId, socketId);
      const id = this.nextId(pageId);
      const time = Date.now();
      this.emit([
        {
          kind: "socket",
          id,
          time,
          pageId,
          socketId,
          direction: "open",
          type: "open",
          message: { url: redactor.url(event.url, time, id) },
        },
      ]);
    });
    const frame =
      (direction: "sent" | "received") =>
      (event: {
        requestId: string;
        timestamp: number;
        response: { opcode: number; payloadData: string };
      }) => {
        const socketId = sockets.get(event.requestId);
        if (socketId === undefined || event.response.opcode !== 1) {
          return;
        }
        this.emit(
          reader.read({
            pageId,
            socketId,
            eventId: this.nextId(pageId),
            time: wall(event.timestamp),
            direction,
            payload: event.response.payloadData,
          }),
        );
      };
    cdp.on("Network.webSocketFrameSent", frame("sent"));
    cdp.on("Network.webSocketFrameReceived", frame("received"));
    cdp.on("Network.webSocketClosed", (event) => {
      const socketId = sockets.get(event.requestId);
      if (socketId === undefined) {
        return;
      }
      sockets.delete(event.requestId);
      this.emit([
        {
          kind: "socket",
          id: this.nextId(pageId),
          time: wall(event.timestamp),
          pageId,
          socketId,
          direction: "close",
          type: "close",
          message: {},
        },
      ]);
    });
  }

  private readStorage(cdp: CDPSession, pageId: string): void {
    const { redactor } = this.options;
    // The values of each storage, to give the old value of a removal, which
    // the protocol does not.
    const shadow = new Map<string, Map<string, string>>();
    type StorageId = {
      securityOrigin?: string;
      storageKey?: string;
      isLocalStorage: boolean;
    };
    const area = (id: StorageId) => {
      const name = `${id.isLocalStorage ? "local" : "session"}|${id.securityOrigin ?? id.storageKey ?? ""}`;
      let values = shadow.get(name);
      if (values === undefined) {
        values = new Map();
        shadow.set(name, values);
      }
      return values;
    };
    const change = (
      id: StorageId,
      op: "set" | "remove" | "clear",
      key: string | null,
      value: string | null,
      oldValue: string | null,
    ) => {
      this.emit([
        readStorage(
          {
            pageId,
            eventId: this.nextId(pageId),
            time: Date.now(),
            area: id.isLocalStorage ? "local" : "session",
            origin: (id.securityOrigin ?? id.storageKey ?? "").replace(
              /\/$/,
              "",
            ),
            op,
            key,
            value,
            oldValue,
          },
          redactor,
        ),
      ]);
    };
    // On a stage, the storage of the app's origin only.
    const ofScreen = (id: StorageId) =>
      this.options.stage === undefined ||
      this.ofApp(id.securityOrigin ?? id.storageKey ?? "");
    cdp.on("DOMStorage.domStorageItemAdded", (event) => {
      if (!ofScreen(event.storageId)) return;
      area(event.storageId).set(event.key, event.newValue);
      change(event.storageId, "set", event.key, event.newValue, null);
    });
    cdp.on("DOMStorage.domStorageItemUpdated", (event) => {
      if (!ofScreen(event.storageId)) return;
      area(event.storageId).set(event.key, event.newValue);
      change(event.storageId, "set", event.key, event.newValue, event.oldValue);
    });
    cdp.on("DOMStorage.domStorageItemRemoved", (event) => {
      if (!ofScreen(event.storageId)) return;
      const values = area(event.storageId);
      const oldValue = values.get(event.key) ?? null;
      values.delete(event.key);
      change(event.storageId, "remove", event.key, null, oldValue);
    });
    cdp.on("DOMStorage.domStorageItemsCleared", (event) => {
      if (!ofScreen(event.storageId)) return;
      area(event.storageId).clear();
      change(event.storageId, "clear", null, null, null);
    });
  }

  private async readCookies(): Promise<void> {
    if (this.closing && this.cookieTimer === null) {
      return;
    }
    const after = (await this.context.cookies()).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
    const events = diffCookies(
      this.cookies,
      after,
      Date.now(),
      () => `cookie#${++this.cookieCount}`,
      this.options.secrets,
    );
    this.cookies = after;
    this.emit(events);
  }
}
