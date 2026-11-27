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
 * The server listens on 127.0.0.1 only. It answers a request only when its
 * `Host` is 127.0.0.1 or localhost on its port, which keeps a page of another
 * site from reaching it through DNS rebinding, and when its `Origin` is one
 * of the origins it was given, which keeps a page of any other origin from
 * reading it. A request with no `Origin`, which a browser sends with every
 * cross-origin `EventSource`, is refused too.
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
  /** A token that every request must give in its `token` query parameter. */
  token?: string;
};

/** How often to send a comment to keep idle connections open, in ms. */
const KEEPALIVE_MS = 15_000;

export class TimelineServer {
  private readonly lines: string[] = [];
  private readonly clients = new Set<ServerResponse>();
  private ended = false;
  private readonly keepalive: ReturnType<typeof setInterval>;

  private constructor(
    private readonly server: Server,
    private readonly origins: ReadonlySet<string>,
    /** The port it listens on. */
    readonly port: number,
    private readonly token: string | null,
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
      options.token ?? null,
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
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (
      this.token !== null &&
      !sameToken(url.searchParams.get("token"), this.token)
    ) {
      response.writeHead(403).end();
      return;
    }
    const path = url.pathname;
    if (request.method !== "GET" || path !== "/timeline") {
      response
        .writeHead(404, {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
        })
        .end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    });
    const last = Number(request.headers["last-event-id"]);
    const from = Number.isInteger(last) && last >= 0 ? last + 1 : 0;
    response.write(
      this.lines
        .slice(from)
        .map((line, index) => message(from + index, line))
        .join(""),
    );
    if (this.ended) {
      response.end("event: end\ndata: {}\n\n");
      return;
    }
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
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

function sameToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
