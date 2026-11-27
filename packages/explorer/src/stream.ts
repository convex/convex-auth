/**
 * Serves the timeline over Server-Sent Events while the recorder writes it,
 * for a viewer that shows the app as it runs.
 *
 * `GET /timeline` sends every line written so far, then each new line as the
 * recorder writes it, one SSE message per line whose `id` is its number in
 * the file (the `recording` event is 0). A client that reconnects with
 * `Last-Event-ID` gets the lines after that one. When the recording ends,
 * the server sends an `end` message and closes.
 *
 * The lines are the lines of the file, the same strings: what the file does
 * not hold, the stream does not either.
 *
 * After the lines written so far, it sends a `caughtup` message: what came
 * before it is the past, what comes after it is new. With controls (see
 * `actions.ts`), it sends their state as an `actions` message after
 * `caughtup` and after each change; those messages are not lines of the
 * file. `POST /action` with `{"id": "<action id>"}` asks for an action.
 *
 * Who may use it. The server listens on 127.0.0.1 only. It answers a request
 * only when:
 *
 * - its `Host` is 127.0.0.1 or localhost on its port, which keeps a page of
 *   another site from reaching it through DNS rebinding;
 * - its `Origin` is one of the origins it was given, which keeps a page of
 *   any other origin from reading the stream or posting an action. A request
 *   with no `Origin`, which a browser sends with every cross-origin
 *   `EventSource` and `fetch`, is refused too. No answer carries a wildcard
 *   `Access-Control-Allow-Origin`;
 * - with a token, it carries the token: `?token=` on the stream (an
 *   `EventSource` cannot send a header), the `X-Explorer-Token` header on an
 *   action. The token is in the link the person opens, after `#`, which the
 *   browser sends to no server; a page of another tab does not have it.
 *
 * An action is a JSON body of at most 1 KiB whose `id` names one action of
 * the list that the project declared; nothing else of it is read. The custom
 * header and the JSON type make the browser ask first (a CORS preflight),
 * which only the given origins pass.
 *
 * Node-only.
 *
 * @module
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export type TimelineServerOptions = {
  /** The port on 127.0.0.1; 0 picks a free one. */
  port: number;
  /** The origins allowed to read the stream, e.g. `http://127.0.0.1:5174`. */
  origins: readonly string[];
  /** A token every request must carry; see the module's comment. */
  token?: string;
};

/** Takes an action id; resolves to null when it started, or why it did not. */
export type ActionHandler = (id: string) => string | null;

/** The header that carries the token on `POST /action`. */
export const TOKEN_HEADER = "x-explorer-token";
const MAX_BODY = 1024;
const ACTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** How often to send a comment to keep idle connections open, in ms. */
const KEEPALIVE_MS = 15_000;

export class TimelineServer {
  private readonly lines: string[] = [];
  private readonly clients = new Set<ServerResponse>();
  private ended = false;
  private readonly keepalive: ReturnType<typeof setInterval>;
  private controls: string | null = null;
  private onAction: ActionHandler | null = null;

  private constructor(
    private readonly server: Server,
    private readonly origins: ReadonlySet<string>,
    /** The port it listens on. */
    readonly port: number,
    private readonly token: Buffer | null,
  ) {
    this.keepalive = setInterval(() => {
      for (const client of this.clients) {
        client.write(": keepalive\n\n");
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  /** Starts the server; rejects when the port is taken. */
  static async start(options: TimelineServerOptions): Promise<TimelineServer> {
    for (const origin of options.origins) {
      if (new URL(origin).origin !== origin) {
        throw new Error(
          `"${origin}" is not an origin: give the scheme, the host, and the port, with no path.`,
        );
      }
    }
    const server = createServer();
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port, "127.0.0.1", () => {
        server.off("error", fail);
        done();
      });
    });
    const stream = new TimelineServer(
      server,
      new Set(options.origins),
      (server.address() as AddressInfo).port,
      options.token === undefined ? null : Buffer.from(options.token),
    );
    server.on("request", (request, response) =>
      stream.handle(request, response),
    );
    return stream;
  }

  /** The URL of the stream, without its token. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/timeline`;
  }

  /** The number of clients connected now. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Takes the actions that `POST /action` asks for. */
  handleActions(handler: ActionHandler): void {
    this.onAction = handler;
  }

  /** Sends the state of the controls (any JSON value) to every client. */
  setControls(state: unknown): void {
    this.controls = JSON.stringify(state);
    for (const client of this.clients) {
      client.write(`event: actions\ndata: ${this.controls}\n\n`);
    }
  }

  private hasToken(given: string | string[] | null | undefined): boolean {
    if (this.token === null) return true;
    if (typeof given !== "string") return false;
    const buffer = Buffer.from(given);
    return (
      buffer.length === this.token.length && timingSafeEqual(buffer, this.token)
    );
  }

  private handle(request: IncomingMessage, response: ServerResponse) {
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    if (
      host !== `127.0.0.1:${this.port}` &&
      host !== `localhost:${this.port}`
    ) {
      response.writeHead(403).end();
      return;
    }
    if (origin === undefined || !this.origins.has(origin)) {
      response.writeHead(403).end();
      return;
    }
    const cors = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    const url = new URL(request.url ?? "/", `http://${host}`);
    const path = url.pathname;
    if (path === "/action" && this.onAction !== null) {
      if (request.method === "OPTIONS") {
        // The preflight carries no token; the request after it must.
        response
          .writeHead(204, {
            ...cors,
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": `content-type, ${TOKEN_HEADER}`,
            "Access-Control-Max-Age": "600",
          })
          .end();
        return;
      }
      if (request.method === "POST") {
        this.action(request, response, cors);
        return;
      }
    }
    if (request.method !== "GET" || path !== "/timeline") {
      response.writeHead(404, cors).end();
      return;
    }
    if (!this.hasToken(url.searchParams.get("token"))) {
      response.writeHead(403, cors).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      ...cors,
    });
    const last = Number(request.headers["last-event-id"]);
    const from = Number.isInteger(last) && last >= 0 ? last + 1 : 0;
    response.write(
      this.lines
        .slice(from)
        .map((line, index) => message(from + index, line))
        .join("") + "event: caughtup\ndata: {}\n\n",
    );
    if (this.ended) {
      response.end("event: end\ndata: {}\n\n");
      return;
    }
    if (this.controls !== null) {
      response.write(`event: actions\ndata: ${this.controls}\n\n`);
    }
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
  }

  private action(
    request: IncomingMessage,
    response: ServerResponse,
    cors: Record<string, string>,
  ) {
    const reply = (status: number, body: object) =>
      response
        .writeHead(status, { ...cors, "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    if (!this.hasToken(request.headers[TOKEN_HEADER])) {
      request.resume();
      reply(403, { error: "no token" });
      return;
    }
    if (
      (request.headers["content-type"] ?? "").split(";")[0].trim() !==
      "application/json"
    ) {
      request.resume();
      reply(415, { error: "send JSON" });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!refused) {
          refused = true;
          reply(413, { error: "too large" });
          request.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (refused) return;
      let id: unknown;
      try {
        id = (
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: unknown;
          }
        )?.id;
      } catch {
        reply(400, { error: "not JSON" });
        return;
      }
      if (typeof id !== "string" || !ACTION_ID.test(id)) {
        reply(400, { error: "no action id" });
        return;
      }
      const refusal = this.ended ? "ended" : this.onAction!(id);
      if (refusal === null) reply(202, { started: id });
      else reply(refusal === "unknown" ? 404 : 409, { refused: refusal });
    });
  }

  /** Sends lines of the file, in order, to every client and keeps them. */
  push(lines: readonly string[]): void {
    if (this.ended || lines.length === 0) {
      return;
    }
    const from = this.lines.length;
    this.lines.push(...lines);
    const text = lines
      .map((line, index) => message(from + index, line))
      .join("");
    for (const client of this.clients) {
      client.write(text);
    }
  }

  /** Tells the clients the recording ended, and stops the server. */
  async end(): Promise<void> {
    if (this.ended) {
      return;
    }
    this.ended = true;
    clearInterval(this.keepalive);
    for (const client of this.clients) {
      client.end("event: end\ndata: {}\n\n");
    }
    this.clients.clear();
    await new Promise<void>((done) => {
      this.server.close(() => done());
      this.server.closeAllConnections();
    });
  }
}

function message(id: number, line: string): string {
  // A line of the file is one line of JSON: it holds no newline.
  return `id: ${id}\ndata: ${line}\n\n`;
}
