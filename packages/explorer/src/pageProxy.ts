/**
 * The page proxy: a server on this machine in front of the app's dev server,
 * for a page in the person's own browser that no recorder drives. It passes
 * every request and WebSocket upgrade through (the dev server's hot reload
 * keeps working), puts the recording script (`pageScript.ts`) first in every
 * HTML document, takes what that script sends, and records the documents and
 * the `Set-Cookie` headers of the app's server as they pass, HttpOnly
 * cookies included.
 *
 * It sits on the origin the app expects (`localhost` on the app's port),
 * with the dev server moved to another port, and passes the `Host` header
 * through, so that the app's server sees its usual origin.
 *
 * Every request must pass, in order:
 *
 * - `Host`: `localhost`, `127.0.0.1` or `[::1]` on the proxy's port. A page
 *   of another site that rebinds its name to 127.0.0.1 sends its own name,
 *   and is refused.
 * - `Origin`, when sent: the proxy's own origin. A page of another origin
 *   cannot read a response, open a WebSocket, or send observations.
 * - `Sec-Fetch-Site`, when sent: `same-origin` or `none` (an address typed
 *   by the person), or `same-site` for the stage's frame (the stage is on
 *   `localhost` too, and every port of it is one site): a frame navigation
 *   whose `Referer`, when sent, is the stage's origin. A request from
 *   another site, or from another page of `localhost`, is refused before
 *   anything else is read.
 * - The run's page token: in the address of the stage's first load of the
 *   screen, which the proxy turns into an HttpOnly, SameSite=Strict cookie
 *   and strips from the address; after that, the cookie. A send of the page
 *   script also needs the token in a header, which no page of another
 *   origin can add without a preflight that the proxy refuses.
 *
 * HTML documents also get `Content-Security-Policy: frame-ancestors` with
 * the stage's origins, so no other page can frame the app.
 *
 * It listens on loopback only: 127.0.0.1, and ::1 where the machine has it.
 * The token never reaches the dev server, the timeline, or a log.
 *
 * Node-only.
 *
 * @module
 */
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { Cookie } from "./browser.ts";
import type { PageIngest } from "./pageIngest.ts";
import {
  INGEST_PATH,
  pageRecorderScript,
  TOKEN_HEADER,
  type PageScriptOptions,
} from "./pageScript.ts";

export type PageProxyOptions = {
  /** The port, on 127.0.0.1 and ::1. */
  port: number;
  /** The app's dev server, such as `http://127.0.0.1:5180`. */
  target: string;
  /** The run's page token. */
  token: string;
  /** The origins of the stage, the only pages that may frame the app. */
  frameAncestors: readonly string[];
  /** Which document records: see `PageScriptOptions.screen`. */
  screen: PageScriptOptions["screen"];
  /** The name of the stage's frame. */
  frame: string;
  deploymentUrl: string;
  ingest: PageIngest;
};

/** The query parameter that carries the token on the stage's first load. */
export const TOKEN_PARAM = "__explorer_token";
/** The most the page script may send at once, in bytes. */
const MAX_INGEST_BYTES = 16 * 1024 * 1024;
/** How much of an HTML document is held to find its `<head>`, in bytes. */
const HEAD_WINDOW = 64 * 1024;

/** Whether two strings are equal, in a time that does not tell how much. */
function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

function withoutCookie(header: string | undefined, name: string) {
  const kept = (header ?? "")
    .split(";")
    .filter((part) => {
      const at = part.indexOf("=");
      return !(at > 0 && part.slice(0, at).trim() === name);
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * A `Set-Cookie` header of the app's server, for a request to `url` at
 * `now` (ms), as the browser stores it; `expired` when it removes the
 * cookie. Null when it is not a cookie.
 */
export function parseSetCookie(
  header: string,
  url: URL,
  now: number,
): { cookie: Cookie; expired: boolean } | null {
  const [pair, ...attributes] = header.split(";");
  const at = pair.indexOf("=");
  if (at < 0) return null;
  const name = pair.slice(0, at).trim();
  if (name.length === 0) return null;
  const value = pair.slice(at + 1).trim();
  let domain: string | null = null;
  let path: string | null = null;
  let expires = -1;
  let maxAge: number | null = null;
  let httpOnly = false;
  let secure = false;
  // Chromium's default, which its DevTools protocol reports as "Lax" too.
  let sameSite = "Lax";
  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    const key = (eq < 0 ? attribute : attribute.slice(0, eq))
      .trim()
      .toLowerCase();
    const val = eq < 0 ? "" : attribute.slice(eq + 1).trim();
    if (key === "domain" && val.length > 0) {
      domain = "." + val.replace(/^\./, "").toLowerCase();
    } else if (key === "path" && val.startsWith("/")) {
      path = val;
    } else if (key === "expires") {
      const time = Date.parse(val);
      if (!Number.isNaN(time)) expires = Math.floor(time / 1000);
    } else if (key === "max-age" && /^-?\d+$/.test(val)) {
      maxAge = Number(val);
    } else if (key === "httponly") {
      httpOnly = true;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "samesite") {
      const lower = val.toLowerCase();
      sameSite =
        lower === "strict" ? "Strict" : lower === "none" ? "None" : "Lax";
    }
  }
  if (maxAge !== null) {
    expires = maxAge <= 0 ? 0 : Math.floor(now / 1000) + maxAge;
  }
  if (path === null) {
    // The default path (RFC 6265, 5.1.4): the request's, up to its last "/".
    const last = url.pathname.lastIndexOf("/");
    path = last <= 0 ? "/" : url.pathname.slice(0, last);
  }
  return {
    cookie: {
      name,
      value,
      domain: domain ?? url.hostname,
      path,
      expires,
      httpOnly,
      secure,
      sameSite,
    },
    expired: expires !== -1 && expires * 1000 <= now,
  };
}

/** Whether a request is for a document, by its `Sec-Fetch-Dest` or `Accept`. */
function isDocument(headers: IncomingHttpHeaders): boolean {
  const dest = headers["sec-fetch-dest"];
  return dest === undefined
    ? (headers.accept ?? "").includes("text/html")
    : dest === "document" || dest === "iframe";
}

/** Where in the start of an HTML document the script goes. */
export function injectionPoint(html: string): number | null {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head !== null) return head.index + head[0].length;
  const tag = /<html(\s[^>]*)?>/i.exec(html);
  if (tag !== null) return tag.index + tag[0].length;
  return null;
}

export class PageProxy {
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Duplex>();
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly script: string;
  private readonly target: URL;
  private readonly cookieName: string;
  private readonly frameAncestors: string;

  private constructor(private readonly options: PageProxyOptions) {
    this.target = new URL(options.target);
    this.cookieName = `__explorer_${options.port}`;
    this.script = pageRecorderScript({
      token: options.token,
      deploymentUrl: options.deploymentUrl,
      screen: options.screen,
      frame: options.frame,
      stageOrigins: options.frameAncestors,
    });
    this.frameAncestors = ["'self'", ...options.frameAncestors].join(" ");
    this.ticker = setInterval(() => options.ingest.tick(), 500);
    this.ticker.unref();
  }

  /** Starts the proxy; rejects when the port is taken. */
  static async start(options: PageProxyOptions): Promise<PageProxy> {
    for (const origin of options.frameAncestors) {
      if (new URL(origin).origin !== origin) {
        throw new Error(`"${origin}" is not an origin.`);
      }
    }
    const proxy = new PageProxy(options);
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer((request, response) =>
        proxy.handle(request, response),
      );
      server.on("upgrade", (request, socket, head) =>
        proxy.upgrade(request, socket, head),
      );
      server.on("connection", (socket) => {
        proxy.sockets.add(socket);
        socket.on("close", () => proxy.sockets.delete(socket));
      });
      try {
        await new Promise<void>((done, fail) => {
          server.once("error", fail);
          server.listen(options.port, host, () => {
            server.off("error", fail);
            done();
          });
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        // A machine without IPv6 loopback: 127.0.0.1 alone.
        if (
          host === "::1" &&
          (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")
        ) {
          continue;
        }
        await proxy.close();
        throw error;
      }
      proxy.servers.push(server);
    }
    return proxy;
  }

  /** The address of the app's page through the proxy. */
  get url(): string {
    return `http://localhost:${this.options.port}`;
  }

  /** The address that loads the screen the first time: with the token. */
  get screenUrl(): string {
    return `${this.url}/?${TOKEN_PARAM}=${encodeURIComponent(this.options.token)}`;
  }

  async close(): Promise<void> {
    clearInterval(this.ticker);
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map(
        (server) => new Promise<void>((done) => server.close(() => done())),
      ),
    );
    this.options.ingest.end();
  }

  /** Null when the request may go on; else why not, for a 403. */
  private refuse(request: IncomingMessage): string | null {
    const { port } = this.options;
    const host = request.headers.host ?? "";
    if (
      ![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(
        host,
      )
    ) {
      return "wrong Host";
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      return "wrong Origin";
    }
    const site = request.headers["sec-fetch-site"];
    if (site === undefined || site === "same-origin" || site === "none") {
      return null;
    }
    if (
      site !== "same-site" ||
      request.headers["sec-fetch-mode"] !== "navigate" ||
      // The stage loads the page in its frame; nothing else of localhost
      // opens it, in a frame or a window.
      this.options.screen !== "stage" ||
      request.headers["sec-fetch-dest"] !== "iframe"
    ) {
      return "request from another site";
    }
    // Every port of localhost is the same site: a navigation from one is the
    // stage's only, which sends its origin as the Referer. A page that sends
    // none is let through (a browser can be set to send none), but its
    // document is not recorded, and the frame-ancestors policy still keeps
    // the app out of any frame but the stage's.
    const referer = this.refererOrigin(request);
    if (referer !== null && !this.options.frameAncestors.includes(referer)) {
      return "navigation from another page";
    }
    return null;
  }

  private refererOrigin(request: IncomingMessage): string | null {
    const referer = request.headers.referer;
    if (referer === undefined) return null;
    try {
      return new URL(referer).origin;
    } catch {
      return "null";
    }
  }

  private authorized(request: IncomingMessage): boolean {
    return sameToken(
      cookieValue(request.headers.cookie, this.cookieName),
      this.options.token,
    );
  }

  private deny(response: ServerResponse, why: string): void {
    response
      .writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .end(
        `explorer: refused (${why}). Open the stage with the link that explorer:live printed.\n`,
      );
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const refused = this.refuse(request);
    if (refused !== null) return this.deny(response, refused);
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (url.searchParams.has(TOKEN_PARAM)) {
      if (
        request.method !== "GET" ||
        !sameToken(
          url.searchParams.get(TOKEN_PARAM) ?? undefined,
          this.options.token,
        )
      ) {
        return this.deny(response, "wrong token");
      }
      url.searchParams.delete(TOKEN_PARAM);
      response
        .writeHead(303, {
          Location: url.pathname + url.search + url.hash,
          "Set-Cookie": `${this.cookieName}=${this.options.token}; Path=/; HttpOnly; SameSite=Strict`,
          "Cache-Control": "no-store",
        })
        .end();
      return;
    }
    if (!this.authorized(request)) return this.deny(response, "no token");

    if (url.pathname === INGEST_PATH) return this.ingest(request, response);
    if (url.pathname.startsWith("/__explorer/")) {
      response.writeHead(404).end();
      return;
    }
    this.forward(request, response, url);
  }

  private ingest(request: IncomingMessage, response: ServerResponse): void {
    const header = request.headers[TOKEN_HEADER];
    if (
      request.method !== "POST" ||
      request.headers.origin === undefined ||
      !sameToken(
        typeof header === "string" ? header : undefined,
        this.options.token,
      ) ||
      !(request.headers["content-type"] ?? "").startsWith("application/json")
    ) {
      return this.deny(response, "not a send of this run's page");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INGEST_BYTES) {
        tooBig = true;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooBig) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const ok = this.options.ingest.receive(body);
      response.writeHead(ok ? 204 : 400, { "Cache-Control": "no-store" }).end();
    });
  }

  /** The headers to send on to the dev server. */
  private upstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
    const out: IncomingHttpHeaders = { ...headers };
    const cookie = withoutCookie(headers.cookie, this.cookieName);
    if (cookie === undefined) delete out.cookie;
    else out.cookie = cookie;
    // Plain bodies, to put the script in the HTML.
    out["accept-encoding"] = "identity";
    delete out[TOKEN_HEADER];
    // A document is never answered from the browser's cache: its script
    // carries the token of the run that served it.
    if (isDocument(headers)) {
      delete out["if-none-match"];
      delete out["if-modified-since"];
    }
    return out;
  }

  private forward(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    const time = Date.now();
    const dest = request.headers["sec-fetch-dest"];
    const screenDest = this.options.screen === "stage" ? "iframe" : "document";
    // The documents of the screen, as the other recorder records them.
    const site = request.headers["sec-fetch-site"];
    const recorded =
      (request.method === "GET" || request.method === "POST") &&
      (dest === undefined
        ? isDocument(request.headers)
        : dest === screenDest) &&
      (site !== "same-site" || this.refererOrigin(request) !== null);
    const upstream = httpRequest(
      {
        host: this.target.hostname,
        port: this.target.port,
        method: request.method,
        path: url.pathname + url.search,
        headers: this.upstreamHeaders(request.headers),
      },
      (reply) => {
        const status = reply.statusCode ?? 502;
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(reply.headers)) {
          if (value === undefined) continue;
          // Nothing of this server is for another origin to read.
          if (name.startsWith("access-control-allow-")) continue;
          headers[name] = value;
        }
        this.cookies(reply.headers["set-cookie"], url);
        const html =
          /^text\/html/i.test(String(reply.headers["content-type"] ?? "")) &&
          request.method !== "HEAD" &&
          status !== 204 &&
          status !== 304;
        if (html) {
          headers["cache-control"] = "no-store";
          delete headers["content-length"];
          const policy = `frame-ancestors ${this.frameAncestors}`;
          const csp = headers["content-security-policy"];
          headers["content-security-policy"] =
            csp === undefined ? policy : [...[csp].flat(), policy];
        }
        response.writeHead(status, reply.statusMessage, headers);
        const done = (failure: string | null) => {
          if (recorded && html) {
            this.options.ingest.document({
              time,
              endTime: Date.now(),
              method: request.method ?? "GET",
              url: url.href,
              status: failure === null ? status : null,
              failure,
            });
          }
        };
        reply.on("error", () => done("net::ERR_FAILED"));
        if (!html) {
          reply.pipe(response);
          reply.on("end", () => done(null));
          return;
        }
        this.injectInto(reply, response, () => done(null));
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response
          .writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
          .end("explorer: the app's dev server does not answer.\n");
      } else {
        response.destroy();
      }
      if (recorded) {
        this.options.ingest.document({
          time,
          endTime: Date.now(),
          method: request.method ?? "GET",
          url: url.href,
          status: null,
          failure: "net::ERR_CONNECTION_REFUSED",
        });
      }
    });
    request.pipe(upstream);
  }

  /** Passes an HTML body on with the script first in it. */
  private injectInto(
    reply: IncomingMessage,
    response: ServerResponse,
    done: () => void,
  ): void {
    const tag = `<script>${this.script}</script>`;
    let held = "";
    let placed = false;
    const place = (final: boolean) => {
      const at = injectionPoint(held);
      if (at === null && !final && held.length < HEAD_WINDOW) return;
      let point = at;
      if (point === null) {
        // No <html> or <head>: after a doctype, else first.
        const doctype = /^\s*<!doctype[^>]*>/i.exec(held);
        point = doctype === null ? 0 : doctype[0].length;
      }
      response.write(held.slice(0, point) + tag + held.slice(point));
      held = "";
      placed = true;
    };
    reply.setEncoding("utf8");
    reply.on("data", (chunk: string) => {
      if (placed) {
        response.write(chunk);
        return;
      }
      held += chunk;
      place(false);
    });
    reply.on("end", () => {
      if (!placed) place(true);
      response.end();
      done();
    });
  }

  private cookies(headers: string[] | undefined, url: URL): void {
    if (headers === undefined || headers.length === 0) return;
    const now = Date.now();
    const set: Cookie[] = [];
    const removed: Cookie[] = [];
    for (const header of headers) {
      const parsed = parseSetCookie(header, url, now);
      if (parsed === null || parsed.cookie.name === this.cookieName) continue;
      (parsed.expired ? removed : set).push(parsed.cookie);
    }
    this.options.ingest.serverCookies(set, removed, now);
  }

  /** A WebSocket upgrade, such as the dev server's hot reload: piped through. */
  private upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const refused =
      this.refuse(request) ??
      (request.headers.origin === undefined
        ? "no Origin"
        : this.authorized(request)
          ? null
          : "no token");
    if (refused !== null) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const upstream: Socket = connect(
      Number(this.target.port),
      this.target.hostname,
      () => {
        const headers = this.upstreamHeaders(request.headers);
        delete headers["accept-encoding"];
        const lines = [`${request.method} ${request.url} HTTP/1.1`];
        for (let i = 0; i < request.rawHeaders.length; i += 2) {
          const name = request.rawHeaders[i].toLowerCase();
          if (
            name === "cookie" ||
            name === "accept-encoding" ||
            name === TOKEN_HEADER
          )
            continue;
          lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
        }
        if (headers.cookie !== undefined)
          lines.push(`Cookie: ${headers.cookie}`);
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
    );
    this.sockets.add(upstream);
    const close = () => {
      upstream.destroy();
      socket.destroy();
      this.sockets.delete(upstream);
    };
    upstream.on("error", close);
    socket.on("error", close);
    upstream.on("close", close);
    socket.on("close", close);
  }
}
