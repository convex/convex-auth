// @vitest-environment node
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BrowserRedactor } from "./browser.ts";
import type { TimelineEvent } from "./events.ts";
import { nodeDigest } from "./nodeDigest.ts";
import { PageIngest } from "./pageIngest.ts";
import {
  injectionPoint,
  PageProxy,
  parseSetCookie,
  TOKEN_PARAM,
} from "./pageProxy.ts";
import { INGEST_PATH, TOKEN_HEADER } from "./pageScript.ts";
import { GENERIC_BROWSER, GENERIC_PROJECT } from "./project.ts";
import { Secrets } from "./secrets.ts";

const TOKEN = "t".repeat(43);
const STAGE = "http://localhost:5174";

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function send(
  port: number,
  headers: Record<string, string>,
  path = "/",
  method = "GET",
  body?: string,
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers, setHost: false },
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
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The status line that a WebSocket upgrade with these headers gets. */
function upgrade(port: number, headers: Record<string, string>) {
  return new Promise<string>((done) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          "GET /hmr HTTP/1.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ].join("\r\n") + "\r\n\r\n",
      );
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\r\n")) {
        socket.destroy();
        done(text.split("\r\n")[0]);
      }
    });
    socket.on("error", (error) => done(String(error)));
  });
}

let upstream: Server;
let proxy: PageProxy;
let port: number;
let events: TimelineEvent[];
let seen: IncomingHttpHeaders[];

beforeEach(async () => {
  seen = [];
  events = [];
  upstream = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/page") {
      const html =
        "<!doctype html><html><head><title>app</title></head></html>";
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": String(Buffer.byteLength(html)),
        "Set-Cookie": ["sid=a-server-session-value; HttpOnly; Path=/"],
        "Access-Control-Allow-Origin": "*",
      });
      res.end(html);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end("export {};");
  });
  upstream.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const secrets = new Secrets(GENERIC_BROWSER, nodeDigest);
  port = await freePort();
  proxy = await PageProxy.start({
    port,
    target,
    token: TOKEN,
    frameAncestors: [STAGE],
    screen: "stage",
    frame: "explorer-screen",
    deploymentUrl: "http://127.0.0.1:3210",
    ingest: new PageIngest({
      redactor: new BrowserRedactor(GENERIC_PROJECT, secrets),
      secrets,
      deploymentUrl: "http://127.0.0.1:3210",
      origin: `http://localhost:${port}`,
      emit: (batch) => events.push(...batch),
    }),
  });
});

afterEach(async () => {
  await proxy.close();
  await new Promise<void>((done) => upstream.close(() => done()));
});

const host = () => ({ Host: `localhost:${port}` });
const authed = () => ({ ...host(), Cookie: `__explorer_${port}=${TOKEN}` });

describe("PageProxy", () => {
  test("refuses a wrong Host, a foreign Origin, another site, and a missing or wrong token", async () => {
    const refused = [
      // DNS rebinding: a page of another name that resolves to 127.0.0.1.
      { ...authed(), Host: `evil.example:${port}` },
      { ...authed(), Origin: "http://evil.example" },
      { ...authed(), Origin: STAGE },
      { ...authed(), "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
      // The stage opens the app in its frame only, not in a window.
      {
        ...authed(),
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        Referer: `${STAGE}/`,
      },
      // Another page of localhost, which is the same site, is not the stage.
      {
        ...authed(),
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
        Referer: "http://localhost:9999/",
      },
      {
        ...authed(),
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "no-cors",
      },
      host(),
      { ...host(), Cookie: `__explorer_${port}=${"x".repeat(43)}` },
      { ...host(), Cookie: `__explorer_${port}=short` },
    ];
    for (const headers of refused) {
      expect((await send(port, headers, "/page")).status).toBe(403);
    }
    expect((await send(port, host(), `/?${TOKEN_PARAM}=wrong`)).status).toBe(
      403,
    );
    expect(seen).toEqual([]);
    expect(events).toEqual([]);
  });

  test("turns the token of the stage's first load into a cookie, and strips it", async () => {
    const reply = await send(
      port,
      {
        ...host(),
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
        Referer: `${STAGE}/`,
      },
      `/page?a=1&${TOKEN_PARAM}=${TOKEN}`,
    );
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe("/page?a=1");
    expect(reply.headers["set-cookie"]).toEqual([
      `__explorer_${port}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
    ]);
    expect(seen).toEqual([]);
  });

  test("passes a document through with the script first, and records it", async () => {
    const reply = await send(
      port,
      {
        ...authed(),
        Cookie: `theirs=1; __explorer_${port}=${TOKEN}`,
        "Accept-Encoding": "gzip",
        "If-None-Match": "abc",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
        Referer: `${STAGE}/`,
      },
      "/page",
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatch(
      /^<!doctype html><html><head><script>\(\(\) => \{[\s\S]+<\/script><title>app<\/title>/,
    );
    expect(reply.body.match(/<\/script>/g)).toHaveLength(1);
    expect(reply.headers["content-length"]).toBeUndefined();
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(reply.headers["content-security-policy"]).toBe(
      `frame-ancestors 'self' ${STAGE}`,
    );
    // The dev server sees the person's cookies, never the token.
    expect(seen[0].cookie).toBe("theirs=1");
    expect(seen[0]["accept-encoding"]).toBe("identity");
    expect(seen[0]["if-none-match"]).toBeUndefined();
    expect(seen[0].host).toBe(`localhost:${port}`);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(events.map((e) => e.kind)).toEqual(["cookie", "http"]);
    expect(events[0]).toMatchObject({ name: "sid", httpOnly: true, op: "set" });
    expect(events[1]).toMatchObject({
      resourceType: "document",
      status: 200,
      url: `http://localhost:${port}/page`,
    });
    expect(JSON.stringify(events)).not.toContain("a-server-session-value");
  });

  test("takes sends of the page script only with the token, from its origin", async () => {
    const body = JSON.stringify({
      doc: "d",
      seq: 0,
      items: [{ type: "console", level: "error", text: "hello" }],
    });
    const origin = `http://localhost:${port}`;
    const json = { "Content-Type": "application/json" };
    for (const headers of [
      { ...authed(), ...json, Origin: origin },
      { ...authed(), ...json, Origin: origin, [TOKEN_HEADER]: "nope" },
      { ...authed(), ...json, [TOKEN_HEADER]: TOKEN },
      { ...authed(), ...json, Origin: STAGE, [TOKEN_HEADER]: TOKEN },
      { ...host(), ...json, Origin: origin, [TOKEN_HEADER]: TOKEN },
      {
        ...authed(),
        "Content-Type": "text/plain",
        Origin: origin,
        [TOKEN_HEADER]: TOKEN,
      },
    ]) {
      expect(
        (await send(port, headers, INGEST_PATH, "POST", body)).status,
      ).toBe(403);
    }
    expect(events).toEqual([]);
    const ok = await send(
      port,
      { ...authed(), ...json, Origin: origin, [TOKEN_HEADER]: TOKEN },
      INGEST_PATH,
      "POST",
      body,
    );
    expect(ok.status).toBe(204);
    expect(events).toMatchObject([{ kind: "console", text: "hello" }]);
    expect(seen).toEqual([]);
  });

  test("passes a WebSocket upgrade through only with the token, from its origin", async () => {
    const origin = `http://localhost:${port}`;
    expect(await upgrade(port, { ...authed(), Origin: origin })).toBe(
      "HTTP/1.1 101 Switching Protocols",
    );
    for (const headers of [
      { ...host(), Origin: origin },
      { ...authed(), Origin: "http://evil.example" },
      { ...authed() },
      { ...authed(), Origin: origin, Host: `evil.example:${port}` },
    ]) {
      expect(await upgrade(port, headers)).toBe("HTTP/1.1 403 Forbidden");
    }
  });
});

describe("parseSetCookie", () => {
  const url = new URL("http://localhost:5173/auth/callback");
  test("reads the attributes as the browser stores them", () => {
    expect(
      parseSetCookie(
        "a=b; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict",
        url,
        1_000_000,
      ),
    ).toEqual({
      cookie: {
        name: "a",
        value: "b",
        domain: "localhost",
        path: "/",
        expires: 1060,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
      expired: false,
    });
    expect(parseSetCookie("a=b", url, 0)?.cookie).toMatchObject({
      path: "/auth",
      expires: -1,
      sameSite: "Lax",
    });
    expect(parseSetCookie("a=; Max-Age=0", url, 0)?.expired).toBe(true);
    expect(
      parseSetCookie("a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT", url, 5000)
        ?.expired,
    ).toBe(true);
    expect(parseSetCookie("nonsense", url, 0)).toBeNull();
  });
});

describe("injectionPoint", () => {
  test("after <head>, else after <html>", () => {
    expect(injectionPoint("<!doctype html><html lang=en><head>")).toBe(35);
    expect(injectionPoint("<html><body>")).toBe(6);
    expect(injectionPoint("<!doctype html><div>")).toBeNull();
  });
});
