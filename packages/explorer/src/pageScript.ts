/**
 * The scripts that run inside the app's page.
 *
 * {@link inputListenerSource} is the listener of the person's actions, which
 * both recorders inject: the one that drives a browser over the DevTools
 * protocol (`browserRecorder.ts`), and the page proxy (`pageProxy.ts`).
 *
 * {@link pageRecorderScript} is the recording script that the page proxy puts
 * first in every HTML document of the app, for a page in the person's own
 * browser, which no recorder drives. It observes from inside the page what
 * the DevTools protocol shows from outside, and sends it to the proxy on the
 * same origin; `pageIngest.ts` turns it into the same events.
 *
 * The scripts are strings, not functions: the transform of tsx can add
 * helpers to a function's source that the page lacks.
 *
 * @module
 */

/**
 * The listener of clicks, typing (sent once the person pauses or leaves the
 * field), submits, and the Enter and Escape keys, with each element and its
 * place on the page. `sink` is an expression of the function that gets each
 * action. It never reads the value of a password field.
 */
export const inputListenerSource = (sink: string): string => `{
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
    try { (${sink})({ action, time: Date.now(), target: describe(el), value }); } catch {}
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
}
`;

/** The path of the proxy that takes what the page script sends. */
export const INGEST_PATH = "/__explorer/ingest";

/** The header that carries the run's page token on each send. */
export const TOKEN_HEADER = "x-explorer-token";

export type PageScriptOptions = {
  /** The page token of the run, which the proxy requires on each send. */
  token: string;
  /** The deployment, to tell its WebSocket and its HTTP API. */
  deploymentUrl: string;
  /**
   * Which document records: the stage's frame named `frame` whose parent is
   * the top window of one of `stageOrigins` ("stage"), or a top window
   * ("top"). Any other document of the app runs as if the script were not
   * there.
   */
  screen: "stage" | "top";
  /** The name of the stage's frame. */
  frame: string;
  /** The origins of the stage. */
  stageOrigins: readonly string[];
};

/**
 * The recording script, for an inline `<script>` first in the document. It
 * changes nothing that the app sees: every function it wraps returns what it
 * returned, throws what it threw, and runs in the same order; it adds no
 * global but the switch of the client step reports. It reads no password
 * field, and observes only the deployment's WebSocket and the requests of
 * the page.
 */
export function pageRecorderScript(options: PageScriptOptions): string {
  const config = JSON.stringify({
    token: options.token,
    ingest: INGEST_PATH,
    header: TOKEN_HEADER,
    deployment: new URL(options.deploymentUrl).origin,
    screen: options.screen,
    frame: options.frame,
    stageOrigins: options.stageOrigins,
  })
    // Inline in a <script>: no "</script>" or "<!--" can end it early.
    .replace(/</g, "\\u003c");
  return `(() => {
"use strict";
const CONFIG = ${config};
const w = window;
let screen = false;
try {
  if (CONFIG.screen === "top") {
    screen = w.top === w;
  } else {
    const ancestors = location.ancestorOrigins;
    screen = w.name === CONFIG.frame && w.parent !== w && w.parent === w.top &&
      (ancestors === undefined || (ancestors.length === 1 &&
        CONFIG.stageOrigins.includes(ancestors[0])));
  }
} catch {}
if (!screen) return;
w.__CONVEX_AUTH_REPORT_STEPS__ = true;

// What the app may replace later; the script uses its own copies.
const nativeFetch = w.fetch;
const now = Date.now;
const stringify = JSON.stringify;
const later = w.setTimeout.bind(w);
const doc = (w.crypto && typeof w.crypto.randomUUID === "function")
  ? w.crypto.randomUUID() : String(Math.random()).slice(2);

// ---- sending, in order: one request at a time, numbered.
let seq = 0;
let inFlight = 0;
let queued = false;
const queue = [];
const post = (items, final) => {
  const body = stringify({ doc, seq: seq++, items });
  inFlight++;
  const done = () => { inFlight--; if (queue.length > 0) schedule(); };
  try {
    nativeFetch.call(w, CONFIG.ingest, {
      method: "POST",
      headers: { "content-type": "application/json", [CONFIG.header]: CONFIG.token },
      body,
      credentials: "same-origin",
      cache: "no-store",
      keepalive: final === true && body.length < 60000,
    }).then(done, done);
  } catch { inFlight--; }
};
const flush = (final) => {
  queued = false;
  if (queue.length === 0 || (inFlight > 0 && final !== true)) return;
  post(queue.splice(0), final);
};
const schedule = () => {
  if (queued) return;
  queued = true;
  later(flush, 0);
};
const send = (item) => {
  if (item.time === undefined) item.time = now();
  queue.push(item);
  schedule();
};
w.addEventListener("pagehide", () => flush(true));

// ---- the document, its navigations and its load.
send({ type: "document", url: location.href });
w.addEventListener("load", () => send({ type: "load", url: location.href }));
const navigated = () => send({ type: "navigated", url: location.href });
for (const name of ["pushState", "replaceState"]) {
  const original = History.prototype[name];
  History.prototype[name] = function () {
    const result = original.apply(this, arguments);
    try { if (this === w.history) navigated(); } catch {}
    return result;
  };
}
w.addEventListener("popstate", navigated);
w.addEventListener("hashchange", navigated);

// ---- the person's actions.
${inputListenerSource('(input) => { input.type = "input"; send(input); }')}

// ---- the console: step reports, errors, warnings, uncaught errors.
const textOf = (args) => Array.prototype.map.call(args, (arg) => {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return String(arg.stack || arg);
  try { const json = stringify(arg); return json === undefined ? String(arg) : json; }
  catch { return String(arg); }
}).join(" ");
for (const [method, level] of [["log", null], ["warn", "warning"], ["error", "error"]]) {
  const original = console[method];
  if (typeof original !== "function") continue;
  console[method] = function () {
    const result = original.apply(this, arguments);
    try {
      if (level === null) {
        if (typeof arguments[0] === "string" && arguments[0].startsWith("[explorer:step] "))
          send({ type: "step", text: textOf(arguments) });
      } else {
        send({ type: "console", level, text: textOf(arguments) });
      }
    } catch {}
    return result;
  };
}
w.addEventListener("error", (event) => {
  if (!(event instanceof ErrorEvent)) return;
  const error = event.error;
  send({ type: "console", level: "uncaught",
    text: error instanceof Error ? String(error.stack || error) : String(error === undefined ? event.message : error) });
});
w.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  send({ type: "console", level: "uncaught",
    text: reason instanceof Error ? String(reason.stack || reason) : String(reason) });
});

// ---- HTTP: fetch and XMLHttpRequest. The bodies of the deployment's HTTP
// API only, as the other recorder keeps of the others none.
const API = ["/api/query", "/api/mutation", "/api/action"];
const absolute = (url) => { try { return new URL(url, location.href).href; } catch { return String(url); } };
const isApi = (url) => {
  try {
    const parsed = new URL(url, location.href);
    return parsed.origin === CONFIG.deployment && API.includes(parsed.pathname.replace(/\\/$/, ""));
  } catch { return false; }
};
let requests = 0;
const httpDone = (call, status, failure, responseBody) => {
  Promise.resolve(call.requestBody).then((requestBody) => send({
    type: "http", resourceType: call.resourceType, time: call.time, endTime: now(),
    method: call.method, url: call.url, status, failure,
    requestBody: typeof requestBody === "string" ? requestBody : null,
    responseBody: typeof responseBody === "string" ? responseBody : null,
  }), () => {});
};
if (typeof nativeFetch === "function") {
  w.fetch = function fetch(input, init) {
    let call = null;
    try {
      const request = input instanceof Request ? input : null;
      const url = absolute(request !== null ? request.url : input instanceof URL ? input.href : input);
      const method = String((init && init.method) || (request !== null ? request.method : "GET")).toUpperCase();
      let requestBody = null;
      if (isApi(url)) {
        if (init && typeof init.body === "string") requestBody = init.body;
        else if (request !== null && !(init && "body" in init) && !request.bodyUsed)
          requestBody = request.clone().text().catch(() => null);
      }
      call = { id: ++requests, url, method, time: now(), requestBody, resourceType: "fetch", api: isApi(url) };
    } catch { call = null; }
    const result = nativeFetch.apply(this, arguments);
    if (call !== null) {
      result.then((response) => {
        try {
          if (call.api) {
            response.clone().text().then(
              (body) => httpDone(call, response.status, null, body),
              (error) => httpDone(call, response.status, String(error), null));
          } else {
            httpDone(call, response.status, null, null);
          }
        } catch {}
      }, (error) => {
        try { httpDone(call, null, String(error && error.name || error), null); } catch {}
      });
    }
    return result;
  };
}
const xhrCalls = new WeakMap();
const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url) {
  const result = xhrOpen.apply(this, arguments);
  try {
    xhrCalls.set(this, { method: String(method).toUpperCase(), url: absolute(url) });
  } catch {}
  return result;
};
const xhrListening = new WeakSet();
XMLHttpRequest.prototype.send = function (body) {
  // The listeners go first: a synchronous request ends within send. They
  // are added once per object, which a page can open and send again.
  try {
    const opened = xhrCalls.get(this);
    if (opened !== undefined) {
      opened.time = now();
      opened.resourceType = "xhr";
      opened.failure = null;
      opened.requestBody = isApi(opened.url) && typeof body === "string" ? body : null;
      opened.sent = true;
      if (!xhrListening.has(this)) {
        xhrListening.add(this);
        for (const name of ["error", "abort", "timeout"])
          this.addEventListener(name, () => { const call = xhrCalls.get(this); if (call) call.failure = name; });
        this.addEventListener("loadend", () => {
          const call = xhrCalls.get(this);
          if (call === undefined || call.sent !== true) return;
          call.sent = false;
          let text = null;
          try {
            if (isApi(call.url) && (this.responseType === "" || this.responseType === "text")) text = this.responseText;
          } catch {}
          httpDone(call, call.failure === null ? this.status : null, call.failure, text);
        });
      }
    }
  } catch {}
  return xhrSend.apply(this, arguments);
};

// ---- the deployment's WebSocket: opened, each text message, closed.
const NativeSocket = w.WebSocket;
if (typeof NativeSocket === "function") {
  const sockets = new WeakMap();
  let socketCount = 0;
  const deploymentSocket = (url) => {
    try {
      const parsed = new URL(url);
      const deployment = new URL(CONFIG.deployment);
      return parsed.host === deployment.host &&
        parsed.protocol === deployment.protocol.replace("http", "ws");
    } catch { return false; }
  };
  const nativeSend = NativeSocket.prototype.send;
  NativeSocket.prototype.send = function (data) {
    const result = nativeSend.apply(this, arguments);
    try {
      const id = sockets.get(this);
      if (id !== undefined && typeof data === "string")
        send({ type: "socket", socket: id, direction: "sent", payload: data });
    } catch {}
    return result;
  };
  w.WebSocket = new Proxy(NativeSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      try {
        if (deploymentSocket(socket.url)) {
          const id = ++socketCount;
          sockets.set(socket, id);
          send({ type: "socket", socket: id, direction: "open", url: socket.url });
          socket.addEventListener("message", (event) => {
            if (typeof event.data === "string")
              send({ type: "socket", socket: id, direction: "received", payload: event.data });
          });
          socket.addEventListener("close", () => send({ type: "socket", socket: id, direction: "close" }));
        }
      } catch {}
      return socket;
    },
  });
}

// ---- localStorage and sessionStorage: what this document writes, and what
// the other documents of the origin write (the storage event).
const areaOf = (storage) => {
  try {
    if (storage === w.localStorage) return "local";
    if (storage === w.sessionStorage) return "session";
  } catch {}
  return null;
};
const getItem = Storage.prototype.getItem;
const setItem = Storage.prototype.setItem;
const removeItem = Storage.prototype.removeItem;
const clear = Storage.prototype.clear;
Storage.prototype.setItem = function (key) {
  let before = null;
  let area = null;
  try { area = areaOf(this); if (area !== null) before = getItem.call(this, String(key)); } catch {}
  const result = setItem.apply(this, arguments);
  try {
    if (area !== null) {
      const after = getItem.call(this, String(key));
      if (after !== before) send({ type: "storage", area, op: "set", key: String(key), value: after, oldValue: before });
    }
  } catch {}
  return result;
};
Storage.prototype.removeItem = function (key) {
  let before = null;
  let area = null;
  try { area = areaOf(this); if (area !== null) before = getItem.call(this, String(key)); } catch {}
  const result = removeItem.apply(this, arguments);
  try {
    if (area !== null && before !== null)
      send({ type: "storage", area, op: "remove", key: String(key), value: null, oldValue: before });
  } catch {}
  return result;
};
Storage.prototype.clear = function () {
  let had = false;
  let area = null;
  try { area = areaOf(this); had = area !== null && this.length > 0; } catch {}
  const result = clear.apply(this, arguments);
  try { if (had) send({ type: "storage", area, op: "clear", key: null, value: null, oldValue: null }); } catch {}
  return result;
};
w.addEventListener("storage", (event) => {
  const area = areaOf(event.storageArea);
  if (area === null) return;
  if (event.key === null) send({ type: "storage", area, op: "clear", key: null, value: null, oldValue: null });
  else if (event.newValue === null) send({ type: "storage", area, op: "remove", key: event.key, value: null, oldValue: event.oldValue });
  else send({ type: "storage", area, op: "set", key: event.key, value: event.newValue, oldValue: event.oldValue });
});

// ---- the cookies the page can read, with the Cookie Store API where the
// browser has it. HttpOnly cookies are the proxy's to see.
const cookieStore = w.cookieStore;
if (cookieStore !== undefined && cookieStore !== null && typeof cookieStore.getAll === "function") {
  const sameSite = (value) => value === "strict" ? "Strict" : value === "none" ? "None" : "Lax";
  const cookie = (c) => ({
    name: String(c.name), value: String(c.value),
    domain: c.domain === null || c.domain === undefined ? location.hostname : String(c.domain),
    path: c.path === null || c.path === undefined ? "/" : String(c.path),
    expires: typeof c.expires === "number" ? c.expires / 1000 : -1,
    secure: c.secure === true, sameSite: sameSite(c.sameSite),
  });
  const time = now();
  cookieStore.getAll().then(
    (list) => send({ type: "cookies", time, changed: list.map(cookie), deleted: [] }),
    () => {});
  cookieStore.addEventListener("change", (event) => {
    try {
      send({ type: "cookies", changed: Array.from(event.changed, cookie), deleted: Array.from(event.deleted, cookie) });
    } catch {}
  });
}
})();`;
}
