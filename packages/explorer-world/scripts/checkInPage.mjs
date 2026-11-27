// Checks `explorer:live` as a person uses it: the command prints one link and
// starts no browser; a browser the command did not start (a plain Playwright
// Chromium here, standing in for the person's own) opens the link, and a
// person's real clicks and keys on the stage's screen sign up, reload, sign
// out and sign in on the username-password example. It asserts:
//
// - the command printed one link and started no browser process;
// - the events, by kind: the page's documents, navigations and loads, the
//   person's actions with each element's place, the deployment's WebSocket
//   both ways, the HTTP of the page, tokens landing in localStorage by their
//   labels and leaving it at sign-out, calls linked to runs, and the client
//   library's steps from the page;
// - no secret in the timeline file or the stream: not the password, not a
//   JWT-looking string, not any raw token the page held in its storage;
// - a page of another origin, in another tab of the same browser, can
//   neither read the page through the proxy, nor send observations, nor
//   read the stream, nor frame the app; and requests to each server with a
//   foreign Origin, a wrong Host, or a missing or wrong token are refused;
// - after Ctrl-C (SIGINT to the command), no process it started is left.
//
// With `--recorder cdp`, it runs the same actions through the recorder that
// drives its own Chromium (in its window, over its DevTools port, under
// xvfb-run without a display), and skips what only the in-page route has.
// With `--compare`, it runs both and prints the counts by kind side by side.
//
//   pnpm --filter @convex-dev/explorer-world check:in-page [--recorder cdp | --compare]
//
// Needs the example's dependencies, `pnpm build` at the root, and Playwright
// with a Chromium (`require("playwright")`). About two minutes a run.
/* global setTimeout, URL -- Node globals. */
/* global explorerStage, localStorage, document, window -- run in the page. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const { values: flags } = parseArgs({
  options: {
    recorder: { type: "string", default: "in-page" },
    compare: { type: "boolean", default: false },
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(root, "../../examples/react-username-password");
const WORLD_PORT = 5574;
const STREAM_PORT = 5599;
const DEBUG_PORT = 9533;
const HOSTILE_PORT = 5588;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function processes() {
  const { stdout } = spawnSync("ps", ["-eo", "pid=,ppid=,stat=,args="], {
    encoding: "utf8",
  });
  const found = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match && !match[3].startsWith("Z"))
      found.set(match[1], { ppid: match[2], args: match[4] });
  }
  return found;
}
/** The processes under `pid`, itself excluded. */
function descendants(pid, all = processes()) {
  const out = [];
  const walk = (parent) => {
    for (const [child, info] of all) {
      if (info.ppid === String(parent)) {
        out.push([child, info.args]);
        walk(child);
      }
    }
  };
  walk(pid);
  return out;
}
const isBrowser = (args) => /chrom|headless_shell/i.test(args);

/** A raw HTTP request, to set any `Host` and `Origin`. */
function raw(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((done) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers, setHost: false },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
          // A stream that answers stays open: what came first is enough.
          if (text.length > 0 && response.statusCode === 200)
            response.destroy();
        });
        response.on("close", () => done({ status: response.statusCode, text }));
      },
    );
    req.on("error", (error) => done({ status: null, text: String(error) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A WebSocket upgrade with these headers: the status line it gets. */
function upgrade(port, headers) {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [
        "GET / HTTP/1.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol: vite-hmr",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\r\n")) {
        done(text.split("\r\n")[0]);
        socket.destroy();
      }
    });
    socket.on("error", (error) => done(String(error)));
    setTimeout(() => {
      done(text.split("\r\n")[0] || "no answer");
      socket.destroy();
    }, 3000);
  });
}

async function run(recorder) {
  const failures = [];
  const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"} [${recorder}] ${message}`);
    if (!ok) failures.push(message);
  };
  const cdp = recorder === "cdp";
  const before = processes();

  const command = [
    join(root, "scripts/live.mjs"),
    appDir,
    "--view",
    "stage",
    "--recorder",
    recorder,
    "--world-port",
    String(WORLD_PORT),
    "--stream-port",
    String(STREAM_PORT),
    ...(cdp
      ? ["--browser", "chromium", "--debug-port", String(DEBUG_PORT)]
      : []),
  ];
  // The recorder's own window needs a display.
  const xvfb = cdp && !process.env.DISPLAY;
  const [bin, args] = xvfb
    ? [
        "xvfb-run",
        ["-a", "-s", "-screen 0 1600x1000x24", process.execPath, ...command],
      ]
    : [process.execPath, command];
  const lines = [];
  const launcher = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: xvfb,
  });
  const exited = new Promise((done) =>
    launcher.on("exit", (code) => done(code)),
  );
  let pending = "";
  const onOutput = (chunk) => {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    for (const line of parts) {
      lines.push(line);
      // The link carries the run's tokens: not echoed whole.
      console.log(
        `  | ${line.replace(/(token(%3D|=))[A-Za-z0-9_-]+/g, "$1…")}`,
      );
    }
  };
  launcher.stdout.on("data", onOutput);
  launcher.stderr.on("data", onOutput);
  const stopCommand = () => {
    try {
      if (xvfb) process.kill(-launcher.pid, "SIGINT");
      else launcher.kill("SIGINT");
    } catch {
      // Already gone.
    }
  };
  async function until(what, timeoutMs, predicate) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      if (launcher.exitCode !== null)
        throw new Error(`${what}: the command exited.`);
      await sleep(200);
    }
    throw new Error(`${what}: not within ${timeoutMs / 1000} s.`);
  }

  let browser = null;
  let hostileServer = null;
  const password = `pw-${Math.random().toString(36).slice(2)}Zq7`;
  const rawTokens = new Set();
  let counts = null;
  try {
    await until("the command is ready", 240_000, () =>
      lines.some((l) => /use the app on the stage's screen/.test(l)),
    );
    const runDir = /logs and the timeline go to (\S+)/.exec(
      lines.find((l) => /timeline go to/.test(l)) ?? "",
    )?.[1];

    let page;
    let link = null;
    if (cdp) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
      page = browser.contexts()[0].pages()[0];
    } else {
      const links = lines.filter((l) => /^\s+http:\/\/\S+$/.test(l));
      check(
        links.length === 1,
        `the command printed one link (${links.length})`,
      );
      link = links[0]?.trim();
      check(
        /^http:\/\/localhost:\d+\/stage\.html\?/.test(link ?? ""),
        "the link is the stage, on localhost",
      );
      const started = descendants(launcher.pid).filter(([, a]) => isBrowser(a));
      check(
        started.length === 0,
        `the command started no browser${started.length ? `: ${started.map(([p, a]) => `${p} ${a.slice(0, 80)}`).join("; ")}` : ""}`,
      );
      // The person's own browser: one the command knows nothing of.
      browser = await chromium.launch({
        args: [
          "--use-gl=angle",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          "--ignore-gpu-blocklist",
        ],
      });
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
      });
      page = await context.newPage();
      await page.goto(link);
    }

    const screen = () =>
      page.frames().find((f) => f.name() === "explorer-screen");
    await until("the page shows on the screen", 90_000, async () => {
      const f = screen();
      return (
        f &&
        (await f
          .locator("#username")
          .count()
          .catch(() => 0)) > 0
      );
    });
    await until("the stage drew", 90_000, () =>
      page.evaluate(() => explorerStage.frames.count > 10),
    );
    await sleep(1500);
    if (!cdp) {
      check(
        !/__explorer_token/.test(screen().url()),
        "the page's address no longer holds the token",
      );
    }

    // A person: real pointer clicks and the keyboard, on the screen.
    const type = async (selector, text) => {
      await screen().locator(selector).click();
      await page.keyboard.type(text, { delay: 30 });
    };
    const signedIn = () => screen().getByRole("button", { name: "Sign out" });
    const grabTokens = () =>
      screen()
        .evaluate(() =>
          Object.entries(localStorage)
            .filter(([k]) => /^__convexAuth/.test(k))
            .map(([, v]) => v),
        )
        .then((values) =>
          values.forEach((v) => v.length > 16 && rawTokens.add(v)),
        );
    const at = {};
    await screen()
      .getByRole("link", { name: /sign up/i })
      .click();
    await screen().waitForURL(/signup/);
    const username = `inpage-${Date.now().toString(36)}`;
    await type("#username", username);
    await type("#password", password);
    at.signUp = Date.now();
    await screen().locator("button[type=submit]").click();
    await signedIn().waitFor({ timeout: 30_000 });
    await sleep(2500);
    await grabTokens();
    at.reload = Date.now();
    await page.getByRole("button", { name: "Reload the page" }).click();
    await until("signed in after the reload", 30_000, async () => {
      const f = screen();
      return (
        f && (await f.getByRole("button", { name: "Sign out" }).count()) > 0
      );
    });
    await sleep(2500);
    await grabTokens();
    at.signOut = Date.now();
    await signedIn().click();
    await screen().waitForURL(/login/);
    await sleep(2500);
    await type("#username", username);
    await type("#password", password);
    at.signIn = Date.now();
    await screen().locator("button[type=submit]").click();
    await signedIn().waitFor({ timeout: 30_000 });
    await sleep(3000);
    await grabTokens();
    check(rawTokens.size >= 2, `the page held tokens (${rawTokens.size} seen)`);

    // Another site in another tab of the same browser.
    if (!cdp) {
      const proxyOrigin = new URL(
        decodeURIComponent(/screen=([^&]+)/.exec(link)[1]),
      ).origin;
      const streamLink = decodeURIComponent(/live=([^&]+)/.exec(link)[1]);
      const streamNoToken = streamLink.replace(/\?.*$/, "");
      hostileServer = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><title>hostile</title>
<iframe id=f src="${proxyOrigin}/"></iframe>
<script>
window.results = {};
const note = (k, v) => { window.results[k] = v; };
fetch("${proxyOrigin}/", { credentials: "include" }).then(r => r.text()).then(
  t => note("read", "read " + t.length), e => note("read", "refused"));
fetch("${proxyOrigin}/__explorer/ingest", { method: "POST", credentials: "include",
  headers: { "content-type": "text/plain" },
  body: JSON.stringify({ doc: "evil", seq: 0, items: [{ type: "console", level: "error", text: "HOSTILE" }] }) })
  .then(r => note("ingest", "status " + r.status), e => note("ingest", "refused"));
fetch("${proxyOrigin}/__explorer/ingest", { method: "POST", mode: "no-cors", credentials: "include",
  body: JSON.stringify({ doc: "evil2", seq: 0, items: [{ type: "console", level: "error", text: "HOSTILE" }] }) })
  .then(r => note("ingestNoCors", "type " + r.type), e => note("ingestNoCors", "refused"));
for (const [k, u] of [["stream", "${streamNoToken}"], ["streamWithToken", "${streamLink}"]]) {
  const s = new EventSource(u);
  s.onmessage = () => { note(k, "read"); s.close(); };
  s.onerror = () => { if (!window.results[k]) note(k, "refused"); s.close(); };
}
const ws = new WebSocket("${proxyOrigin.replace("http", "ws")}/", "vite-hmr");
ws.onopen = () => note("socket", "open"); ws.onerror = () => note("socket", "refused");
setTimeout(() => { try { note("frame", document.getElementById("f").contentDocument ? "readable" : "blocked"); } catch { note("frame", "blocked"); } }, 1500);
</script>`);
      });
      await new Promise((done) =>
        hostileServer.listen(HOSTILE_PORT, "127.0.0.1", done),
      );
      at.hostile = Date.now();
      for (const host of ["127.0.0.1", "localhost"]) {
        const tab = await page.context().newPage();
        const frameLoads = [];
        tab.on("response", (r) => {
          if (
            r.url().startsWith(proxyOrigin) &&
            r.request().resourceType() === "document"
          )
            frameLoads.push(r.status());
        });
        await tab.goto(`http://${host}:${HOSTILE_PORT}/`);
        await sleep(3000);
        const results = await tab.evaluate(() => window.results);
        const frameRan = await tab
          .frames()
          .find((f) => f !== tab.mainFrame())
          ?.evaluate(() => document.title)
          .catch(() => "blocked");
        console.log(
          `     hostile tab at ${host}: ${JSON.stringify(results)}, framed app: ${frameRan}`,
        );
        check(
          results.read === "refused",
          `a tab at ${host} cannot read the page through the proxy`,
        );
        check(
          results.ingest !== "status 204" && results.ingestNoCors !== undefined,
          `a tab at ${host} cannot send observations (${results.ingest}, no-cors: ${results.ingestNoCors})`,
        );
        check(
          results.stream === "refused" && results.streamWithToken === "refused",
          `a tab at ${host} cannot read the stream, even with the token`,
        );
        check(
          results.socket === "refused",
          `a tab at ${host} cannot open a WebSocket through the proxy`,
        );
        check(
          frameRan === "blocked" || frameRan === "" || frameRan === undefined,
          `a tab at ${host} cannot frame the app (${frameRan})`,
        );
        await tab.close();
      }

      at.hostileEnd = Date.now();

      // Each server, from outside a browser.
      const proxyPort = Number(new URL(proxyOrigin).port);
      const good = { Host: `localhost:${proxyPort}` };
      const refusals = [
        [
          "proxy: wrong Host (rebinding)",
          raw(proxyPort, { headers: { Host: `evil.example:${proxyPort}` } }),
        ],
        ["proxy: no token", raw(proxyPort, { headers: good })],
        [
          "proxy: wrong token in the address",
          raw(proxyPort, { path: "/?__explorer_token=nope", headers: good }),
        ],
        [
          "proxy: wrong token cookie",
          raw(proxyPort, {
            headers: { ...good, Cookie: `__explorer_${proxyPort}=nope` },
          }),
        ],
        [
          "proxy: foreign Origin",
          raw(proxyPort, {
            headers: { ...good, Origin: "http://evil.example" },
          }),
        ],
        [
          "proxy: another site",
          raw(proxyPort, {
            headers: { ...good, "Sec-Fetch-Site": "cross-site" },
          }),
        ],
        [
          "ingest: no token",
          raw(proxyPort, {
            method: "POST",
            path: "/__explorer/ingest",
            headers: {
              ...good,
              Origin: proxyOrigin,
              "Content-Type": "application/json",
            },
            body: "{}",
          }),
        ],
        [
          "stream: no token",
          raw(STREAM_PORT, {
            path: "/timeline",
            headers: {
              Host: `127.0.0.1:${STREAM_PORT}`,
              Origin: `http://localhost:${WORLD_PORT}`,
            },
          }),
        ],
        [
          "stream: wrong token",
          raw(STREAM_PORT, {
            path: "/timeline?token=nope",
            headers: {
              Host: `127.0.0.1:${STREAM_PORT}`,
              Origin: `http://localhost:${WORLD_PORT}`,
            },
          }),
        ],
        [
          "stream: foreign Origin",
          raw(STREAM_PORT, {
            path: new URL(streamLink).pathname + new URL(streamLink).search,
            headers: {
              Host: `127.0.0.1:${STREAM_PORT}`,
              Origin: "http://evil.example",
            },
          }),
        ],
        [
          "stream: wrong Host",
          raw(STREAM_PORT, {
            path: new URL(streamLink).pathname + new URL(streamLink).search,
            headers: {
              Host: `evil.example:${STREAM_PORT}`,
              Origin: `http://localhost:${WORLD_PORT}`,
            },
          }),
        ],
      ];
      for (const [what, answer] of refusals) {
        const { status } = await answer;
        check(status === 403, `${what}: refused (${status})`);
      }
      const stream = await raw(STREAM_PORT, {
        path: new URL(streamLink).pathname + new URL(streamLink).search,
        headers: {
          Host: `127.0.0.1:${STREAM_PORT}`,
          Origin: `http://localhost:${WORLD_PORT}`,
        },
      });
      check(
        stream.status === 200,
        `the stream answers the stage's own link (${stream.status})`,
      );
      for (const [what, headers] of [
        ["no token", { Host: `localhost:${proxyPort}`, Origin: proxyOrigin }],
        [
          "foreign Origin",
          { Host: `localhost:${proxyPort}`, Origin: "http://evil.example" },
        ],
        [
          "wrong Host",
          { Host: `evil.example:${proxyPort}`, Origin: proxyOrigin },
        ],
      ]) {
        const status = await upgrade(proxyPort, headers);
        check(
          / 403 /.test(status),
          `proxy WebSocket, ${what}: refused (${status})`,
        );
      }
    }

    await sleep(1500);
    const seen = await page.evaluate((marks) => {
      const ev = explorerStage.feed.events;
      const by = {};
      for (const e of ev) by[e.kind] = (by[e.kind] ?? 0) + 1;
      const storage = ev.filter((e) => e.kind === "storage");
      const m = explorerStage.model();
      return {
        by,
        inputs: ev.filter((e) => e.kind === "input").length,
        inputsWithRect: ev.filter((e) => e.kind === "input" && e.target.rect)
          .length,
        documents: ev.filter(
          (e) => e.kind === "http" && e.resourceType === "document",
        ).length,
        documentsAfterReload: ev.filter(
          (e) =>
            e.kind === "http" &&
            e.resourceType === "document" &&
            e.time >= marks.reload,
        ).length,
        tokensSet: storage.filter(
          (e) => e.op === "set" && e.value && typeof e.value === "object",
        ).length,
        plainTokens: storage.filter(
          (e) => e.op === "set" && typeof e.value === "string",
        ).length,
        removedAfterSignOut: storage.filter(
          (e) =>
            e.op === "remove" &&
            e.time >= marks.signOut &&
            e.time < marks.signIn,
        ).length,
        socketSent: ev.filter(
          (e) => e.kind === "socket" && e.direction === "sent",
        ).length,
        socketReceived: ev.filter(
          (e) => e.kind === "socket" && e.direction === "received",
        ).length,
        socketTypes: [
          ...new Set(ev.filter((e) => e.kind === "socket").map((e) => e.type)),
        ].sort(),
        linkedCalls: ev.filter((e) => e.kind === "call" && e.runId !== null)
          .length,
        calls: ev.filter((e) => e.kind === "call").length,
        pageSteps: ev.filter((e) => e.kind === "step" && e.from === "page")
          .length,
        stepParts: [...new Set(m.steps.map((x) => x.part))],
        elements: m.elements.map((e) => e.label),
        hostile: ev.filter((e) => JSON.stringify(e).includes("HOSTILE")).length,
        hostileTime:
          marks.hostile === undefined
            ? 0
            : ev.filter(
                (e) =>
                  e.time >= marks.hostile &&
                  e.time <= marks.hostileEnd &&
                  e.kind !== "secret",
              ).length,
        stageHttp: ev.filter(
          (e) => e.kind === "http" && new URL(e.url).port === String(5574),
        ).length,
      };
    }, at);
    console.log(`     recorded: ${JSON.stringify(seen.by)}`);
    counts = seen;
    check(
      seen.inputs >= 8 && seen.inputsWithRect === seen.inputs,
      `the person's actions, each with its element's place (${seen.inputs})`,
    );
    check(
      seen.documents >= 2 && seen.documentsAfterReload >= 1,
      `the page's documents, the reload's too (${seen.documents})`,
    );
    check(seen.stageHttp === 0, "nothing of the stage itself is recorded");
    check(
      seen.tokensSet >= 4 && seen.plainTokens === 0,
      `tokens land in localStorage by their labels (${seen.tokensSet} sets, ${seen.plainTokens} in clear)`,
    );
    check(
      seen.removedAfterSignOut >= 1,
      `sign out removes the tokens (${seen.removedAfterSignOut})`,
    );
    check(
      seen.socketSent > 5 && seen.socketReceived > 5,
      `the WebSocket both ways (${seen.socketSent} sent, ${seen.socketReceived} received: ${seen.socketTypes.join(", ")})`,
    );
    check(
      seen.linkedCalls > 0,
      `calls linked to their runs (${seen.linkedCalls} of ${seen.calls})`,
    );
    check(
      seen.pageSteps > 0,
      `the client library's steps arrive from the page (${seen.pageSteps}, in ${seen.stepParts.join(", ")})`,
    );
    check(
      seen.elements.includes("username") && seen.elements.includes("password"),
      `the elements used stand on the page (${seen.elements.join(", ")})`,
    );
    check(seen.hostile === 0, "nothing a hostile tab sent is in the timeline");
    check(
      seen.hostileTime === 0,
      `nothing is recorded while the hostile tabs try (${seen.hostileTime} events)`,
    );

    const streamed = await page.evaluate(() =>
      JSON.stringify(explorerStage.feed.events),
    );
    await browser.close();
    browser = null;
    stopCommand();
    const code = await Promise.race([
      exited,
      sleep(60_000).then(() => "timeout"),
    ]);
    check(code === 0 || xvfb, `the command stopped on Ctrl-C (exit ${code})`);
    const file = runDir ? readFileSync(join(runDir, "run.ndjson"), "utf8") : "";
    // The counts of the file, by kind and by what tells them apart.
    const detail = {};
    for (const line of file.trim().split("\n")) {
      const e = JSON.parse(line);
      const keys = [e.kind];
      if (e.kind === "write")
        keys.push(`write, ${e.snapshot ? "snapshot" : "of a run"}`);
      if (e.kind === "http") keys.push(`http, ${e.resourceType}`);
      if (e.kind === "socket") keys.push(`socket, ${e.direction} ${e.type}`);
      if (e.kind === "page") keys.push(`page, ${e.event}`);
      if (e.kind === "call") keys.push(`call, ${e.link ?? "unlinked"}`);
      if (e.kind === "step") keys.push(`step, from ${e.from}`);
      if (e.kind === "storage") keys.push(`storage, ${e.op}`);
      if (e.kind === "input") keys.push(`input, ${e.action}`);
      for (const k of keys) detail[k] = (detail[k] ?? 0) + 1;
    }
    counts.file = detail;
    check(
      file.length > 0,
      `the timeline was saved (${file.split("\n").length} lines)`,
    );
    for (const [name, text] of [
      ["timeline file", file],
      ["stream", streamed],
    ]) {
      check(!text.includes(password), `the password is not in the ${name}`);
      check(!JWT.test(text), `no JWT-looking string is in the ${name}`);
      const leaked = [...rawTokens].filter((t) => text.includes(t));
      check(
        leaked.length === 0,
        `none of the ${rawTokens.size} raw tokens of the page is in the ${name}`,
      );
    }
    if (!cdp && runDir) {
      const logs = spawnSync(
        "cat",
        [join(runDir, "recorder.log"), join(runDir, "page.log")],
        { encoding: "utf8" },
      ).stdout;
      check(
        !logs.includes(password) && !JWT.test(logs),
        "no secret in the run's logs",
      );
    }
  } catch (error) {
    check(false, error instanceof Error ? error.message : String(error));
  } finally {
    await browser?.close().catch(() => {});
    hostileServer?.close();
    if (launcher.exitCode === null) {
      stopCommand();
      await Promise.race([exited, sleep(60_000)]);
    }
    await sleep(1500);
    const left = [...processes()].filter(
      ([pid, { args }]) =>
        !before.has(pid) &&
        /convex|vite|chrom|tsx|live\.mjs|playwright|explorer|esbuild|Xvfb|node -e/i.test(
          args,
        ) &&
        !/\bps\b/.test(args),
    );
    check(
      left.length === 0,
      `no process left${left.length ? `: ${left.map(([pid, { args }]) => `${pid} ${args.slice(0, 120)}`).join("; ")}` : ""}`,
    );
  }
  return { failures, counts };
}

const modes = flags.compare ? ["in-page", "cdp"] : [flags.recorder];
const results = {};
for (const mode of modes) results[mode] = await run(mode);

if (flags.compare) {
  const kinds = [
    ...new Set(
      Object.values(results).flatMap((r) => Object.keys(r.counts?.file ?? {})),
    ),
  ].sort();
  console.log(
    "\nThe timeline files, by kind:\n\n| kind | in-page | cdp |\n| --- | ---: | ---: |",
  );
  for (const kind of kinds) {
    const [a, b] = ["in-page", "cdp"].map(
      (m) => results[m].counts?.file?.[kind] ?? 0,
    );
    console.log(`| ${kind} | ${a} | ${b} |${a === b ? "" : " ≠"}`);
  }
}
const failures = Object.values(results).flatMap((r) => r.failures);
if (failures.length > 0) {
  console.log(`\nFAIL: ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll in-page checks passed.");
process.exit(0);
