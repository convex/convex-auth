// @vitest-environment node
import { request } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { TimelineServer } from "./stream.ts";

const ORIGIN = "http://127.0.0.1:5174";

let server: TimelineServer | null = null;
afterEach(async () => {
  await server?.end();
  server = null;
});

type Reply = { status: number; headers: Record<string, unknown>; body: string };

/** Reads a response until it ends or `until` holds of what came so far. */
function get(
  port: number,
  headers: Record<string, string>,
  until: (body: string) => boolean = () => false,
  path = "/timeline",
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers },
      (response) => {
        let body = "";
        const finish = () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (until(body)) {
            req.destroy();
            finish();
          }
        });
        response.on("end", finish);
      },
    );
    req.on("error", fail);
    req.end();
  });
}

const allowed = (port: number) => ({
  Host: `127.0.0.1:${port}`,
  Origin: ORIGIN,
});

describe("TimelineServer", () => {
  test("listens on 127.0.0.1 only", async () => {
    server = await TimelineServer.start({ port: 0, origins: [ORIGIN] });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/timeline`);
  });

  test("refuses another origin, no origin, and another host", async () => {
    server = await TimelineServer.start({ port: 0, origins: [ORIGIN] });
    server.push(['{"kind":"recording"}']);
    const { port } = server;
    const refused: Record<string, string>[] = [
      { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" },
      { Host: `127.0.0.1:${port}`, Origin: "http://127.0.0.1:9999" },
      { Host: `127.0.0.1:${port}` },
      { Host: `evil.example:${port}`, Origin: ORIGIN },
    ];
    for (const headers of refused) {
      const reply = await get(port, headers);
      expect(reply.status).toBe(403);
      expect(reply.body).toBe("");
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  test("with a token, refuses a request without it or with another", async () => {
    const token = "k".repeat(43);
    server = await TimelineServer.start({ port: 0, origins: [ORIGIN], token });
    server.push(['{"kind":"recording"}']);
    const { port } = server;
    for (const path of [
      "/timeline",
      "/timeline?token=",
      `/timeline?token=${"x".repeat(43)}`,
      `/timeline?token=${token}x`,
    ]) {
      const reply = await get(port, allowed(port), undefined, path);
      expect(reply.status).toBe(403);
      expect(reply.body).toBe("");
    }
    // The token does not stand in for the origin or the host.
    const others: Record<string, string>[] = [
      { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" },
      { Host: `127.0.0.1:${port}` },
      { Host: `evil.example:${port}`, Origin: ORIGIN },
    ];
    for (const headers of others) {
      const reply = await get(
        port,
        headers,
        undefined,
        `/timeline?token=${token}`,
      );
      expect(reply.status).toBe(403);
    }
    const reply = await get(
      port,
      allowed(port),
      (body) => body.includes("id: 0"),
      `/timeline?token=${token}`,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(
      'id: 0\ndata: {"kind":"recording"}\n\n' + "event: caughtup\ndata: {}\n\n",
    );
  });

  test("sends what was written, then each new line, then the end", async () => {
    server = await TimelineServer.start({ port: 0, origins: [ORIGIN] });
    server.push(['{"a":0}', '{"a":1}']);
    const first = get(server.port, allowed(server.port), (body) =>
      body.includes("event: end"),
    );
    // Let the client connect before more lines come.
    await new Promise((done) => setTimeout(done, 50));
    expect(server.clientCount).toBe(1);
    server.push(['{"a":2}']);
    await server.end();
    const reply = await first;
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/event-stream");
    expect(reply.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(reply.body).toBe(
      'id: 0\ndata: {"a":0}\n\n' +
        'id: 1\ndata: {"a":1}\n\n' +
        "event: caughtup\ndata: {}\n\n" +
        'id: 2\ndata: {"a":2}\n\n' +
        "event: end\ndata: {}\n\n",
    );
    server = null;
  });

  test("resumes after Last-Event-ID", async () => {
    server = await TimelineServer.start({ port: 0, origins: [ORIGIN] });
    server.push(['{"a":0}', '{"a":1}', '{"a":2}']);
    const reply = await get(
      server.port,
      { ...allowed(server.port), "Last-Event-ID": "1" },
      (body) => body.includes("caughtup"),
    );
    expect(reply.body).toBe(
      'id: 2\ndata: {"a":2}\n\n' + "event: caughtup\ndata: {}\n\n",
    );
  });

  test("answers another path with 404", async () => {
    server = await TimelineServer.start({ port: 0, origins: [ORIGIN] });
    const reply = await get(server.port, allowed(server.port), undefined, "/x");
    expect(reply.status).toBe(404);
  });

  test("rejects an origin with a path", async () => {
    await expect(
      TimelineServer.start({ port: 0, origins: [`${ORIGIN}/world`] }),
    ).rejects.toThrow("is not an origin");
  });
});

/** Sends a request with a body and reads the whole reply. */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text,
          }),
        );
      },
    );
    req.on("error", fail);
    req.end(body);
  });
}

const TOKEN = "t0k3n-of-this-run-0123456789abcdef";

/**
 * The hostile-tab cases: a page of another site in another tab of the same
 * browser knows the port (it can scan for it) but not the token, which is in
 * the fragment of the world's link. What it can send: a cross-origin
 * `EventSource` or `fetch` (with its own `Origin`, or none for some modes),
 * a form post (`Origin` of its own, a "simple" content type, no custom
 * header), and requests through a name it controls that resolves to
 * 127.0.0.1 (DNS rebinding: its own `Host`). Each is refused, and no refusal
 * carries `Access-Control-Allow-Origin`, so the page cannot read even that.
 */
describe("TimelineServer with a token and actions", () => {
  const started: string[] = [];
  async function start() {
    server = await TimelineServer.start({
      port: 0,
      origins: [ORIGIN],
      token: TOKEN,
    });
    server.handleActions((id) => {
      if (id !== "signIn") return "unknown";
      started.push(id);
      return null;
    });
    server.push(['{"kind":"recording"}']);
    started.length = 0;
    return server.port;
  }
  const json = (port: number, extra: Record<string, string> = {}) => ({
    ...allowed(port),
    "Content-Type": "application/json",
    "X-Explorer-Token": TOKEN,
    ...extra,
  });

  test("the stream needs the token", async () => {
    const port = await start();
    for (const path of [
      "/timeline",
      "/timeline?token=",
      "/timeline?token=wrong",
      `/timeline?token=${TOKEN}x`,
      `/timeline?token=${TOKEN.slice(0, -1)}`,
    ]) {
      const reply = await get(port, allowed(port), undefined, path);
      expect(reply.status).toBe(403);
      expect(reply.body).toBe("");
    }
    const reply = await get(
      port,
      allowed(port),
      (body) => body.includes("caughtup"),
      `/timeline?token=${TOKEN}`,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('{"kind":"recording"}');
  });

  test("the stream with the token still needs the origin and the host", async () => {
    const port = await start();
    const refused: Record<string, string>[] = [
      { Host: `127.0.0.1:${port}`, Origin: "http://evil.example" },
      { Host: `127.0.0.1:${port}`, Origin: "null" },
      { Host: `127.0.0.1:${port}` },
      { Host: `rebound.evil.example:${port}`, Origin: ORIGIN },
    ];
    for (const headers of refused) {
      const reply = await get(
        port,
        headers,
        undefined,
        `/timeline?token=${TOKEN}`,
      );
      expect(reply.status).toBe(403);
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  test("an action from the world starts", async () => {
    const port = await start();
    const reply = await send(
      port,
      "POST",
      "/action",
      json(port),
      '{"id":"signIn"}',
    );
    expect(reply.status).toBe(202);
    expect(started).toEqual(["signIn"]);
  });

  test("a hostile tab cannot start an action", async () => {
    const port = await start();
    const body = '{"id":"signIn"}';
    const cases: [string, Record<string, string>, string][] = [
      // Its own origin, with or without guessing the token.
      ["other origin", json(port, { Origin: "http://evil.example" }), body],
      ["opaque origin", json(port, { Origin: "null" }), body],
      // A form post: no custom header, a simple type.
      [
        "form post",
        {
          Host: `127.0.0.1:${port}`,
          Origin: "http://evil.example",
          "Content-Type": "text/plain",
        },
        body,
      ],
      // No Origin at all.
      ["no origin", { ...json(port), Origin: "" }, body],
      // DNS rebinding: the page's own name for 127.0.0.1.
      ["rebinding", json(port, { Host: `rebound.evil.example:${port}` }), body],
      // The right origin but no token, or a wrong one (what a page that
      // could forge the origin would still lack).
      [
        "no token",
        { ...allowed(port), "Content-Type": "application/json" },
        body,
      ],
      ["wrong token", json(port, { "X-Explorer-Token": "guess" }), body],
    ];
    for (const [name, headers, payload] of cases) {
      if (headers.Origin === "") delete headers.Origin;
      const reply = await send(port, "POST", "/action", headers, payload);
      expect(reply.status, name).toBeGreaterThanOrEqual(400);
      if (headers.Origin !== ORIGIN)
        expect(
          reply.headers["access-control-allow-origin"],
          name,
        ).toBeUndefined();
    }
    expect(started).toEqual([]);
  });

  test("a preflight passes only for the world's origin", async () => {
    const port = await start();
    const preflight = {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, x-explorer-token",
    };
    const ok = await send(port, "OPTIONS", "/action", {
      ...allowed(port),
      ...preflight,
    });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const evil = await send(port, "OPTIONS", "/action", {
      Host: `127.0.0.1:${port}`,
      Origin: "http://evil.example",
      ...preflight,
    });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("only an id from the list is taken; nothing else of the body", async () => {
    const port = await start();
    const bodies: [string, number][] = [
      ['{"id":"deleteEverything"}', 404],
      ['{"id":"signIn; drop"}', 400],
      ['{"id":"javascript:alert(1)"}', 400],
      ['{"id":{"selector":"#x"}}', 400],
      ['{"script":"document.body"}', 400],
      ["not json", 400],
      [JSON.stringify({ id: "signIn", pad: "x".repeat(2000) }), 413],
    ];
    for (const [body, status] of bodies) {
      const reply = await send(port, "POST", "/action", json(port), body);
      expect(reply.status, body.slice(0, 40)).toBe(status);
    }
    expect(started).toEqual([]);
    const get = await send(port, "GET", "/action", json(port));
    expect(get.status).toBe(404);
  });

  test("sends the controls after caughtup and on each change", async () => {
    const port = await start();
    server!.setControls({ busy: null });
    const reply = get(
      port,
      allowed(port),
      (body) => body.includes('"busy":"signIn"'),
      `/timeline?token=${TOKEN}`,
    );
    await new Promise((done) => setTimeout(done, 50));
    server!.setControls({ busy: "signIn" });
    const { body } = await reply;
    expect(body).toBe(
      'id: 0\ndata: {"kind":"recording"}\n\n' +
        "event: caughtup\ndata: {}\n\n" +
        'event: actions\ndata: {"busy":null}\n\n' +
        'event: actions\ndata: {"busy":"signIn"}\n\n',
    );
  });
});
