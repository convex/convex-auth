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
    expect(reply.body).toBe('id: 0\ndata: {"kind":"recording"}\n\n');
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
      (body) => body.includes("id: 2"),
    );
    expect(reply.body).toBe('id: 2\ndata: {"a":2}\n\n');
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
