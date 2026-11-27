// Checks live mode the way a person uses it: runs `explorer:live` on the
// username-password example with no display, opens the link it prints in a
// plain headless Chromium that the recorder did not launch, and asserts:
//
// - the world is still on load: it shows the present and plays nothing;
// - each control of the world's panel performs its action in the hidden
//   page: its start and end reach the world, then client steps and function
//   runs; and the time from the press to the first of each (the delay);
// - which buttons are enabled follows the page's real state;
// - no raw secret the recorder saw (the generated password, the tokens)
//   and no `eyJ` appears in the stream or in the timeline file;
// - a page of another origin, in another tab of the same browser, can
//   neither start an action nor read the stream, even with the token;
// - after Ctrl-C (SIGINT to the command), no process it started is left.
//
// Needs the example's dependencies, `pnpm build` at the root, and Playwright
// with a Chromium (`require("playwright")`). Takes about a minute.
//
//   pnpm --filter @convex-dev/explorer-world check:controls
/* global setTimeout, URL, URLSearchParams -- Node globals. */
/* global window, document -- run in the page. */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(root, "../../examples/react-username-password");
const WORLD_PORT = 5374;
const STREAM_PORT = 5399;
const HOSTILE_PORT = 5398;
const STREAM = `http://127.0.0.1:${STREAM_PORT}`;

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function processes() {
  const { stdout } = spawnSync("ps", ["-eo", "pid=,stat=,args="], {
    encoding: "utf8",
  });
  const found = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match && !match[2].startsWith("Z")) found.set(match[1], match[3]);
  }
  return found;
}
const before = processes();

// ---------------------------------------------------------------- start --

const scratch = mkdtempSync(join(tmpdir(), "check-controls-"));
const secretsFile = join(scratch, "secrets.txt");
const env = { ...process.env, EXPLORER_CHECK_SECRETS: secretsFile };
// No display, as on a server or in a terminal over SSH.
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
const lines = [];
const launcher = spawn(
  process.execPath,
  [
    join(root, "scripts/live.mjs"),
    appDir,
    "--browser",
    "chromium",
    "--world-port",
    String(WORLD_PORT),
    "--stream-port",
    String(STREAM_PORT),
  ],
  { stdio: ["ignore", "pipe", "pipe"], env },
);
const exited = new Promise((done) => launcher.on("exit", (code) => done(code)));
let pending = "";
const onOutput = (chunk) => {
  pending += chunk.toString();
  const parts = pending.split("\n");
  pending = parts.pop();
  for (const line of parts) {
    lines.push({ at: Date.now(), line });
    console.log(`  | ${line}`);
  }
};
launcher.stdout.on("data", onOutput);
launcher.stderr.on("data", onOutput);
const seen = (pattern) => lines.find(({ line }) => pattern.test(line));
async function until(what, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    if (launcher.exitCode !== null)
      throw new Error(`${what}: the command exited.`);
    await sleep(100);
  }
  throw new Error(`${what}: not within ${timeoutMs / 1000} s.`);
}

/** A page of another origin that tries what a hostile tab can. */
const HOSTILE_PAGE = `<!doctype html><meta charset="utf-8"><body><script>
window.results = {};
const stream = ${JSON.stringify(STREAM)};
const params = new URLSearchParams(location.search);
const token = params.get("token") || "guess";
const note = (name, value) => (window.results[name] = value);
const tryStream = (name, url) => new Promise((done) => {
  const source = new EventSource(url);
  let got = 0;
  source.onmessage = () => got++;
  source.addEventListener("actions", () => got++);
  source.onerror = () => { source.close(); note(name, got ? "read " + got : "refused"); done(); };
  setTimeout(() => { source.close(); note(name, got ? "read " + got : "silent"); done(); }, 3000);
});
const tryFetch = async (name, init) => {
  try {
    const r = await fetch(stream + "/action", init);
    note(name, r.type === "opaque" ? "opaque" : "read " + r.status);
  } catch (e) { note(name, "refused"); }
};
(async () => {
  await Promise.all([
    tryStream("stream", stream + "/timeline"),
    tryStream("streamWithToken", stream + "/timeline?token=" + token),
    tryFetch("post", { method: "POST", headers: { "Content-Type": "application/json", "X-Explorer-Token": token }, body: '{"id":"signOut"}' }),
    tryFetch("postNoCors", { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: '{"id":"signOut"}' }),
    tryFetch("readNoCors", { method: "GET", mode: "no-cors" }),
  ]);
  // A form post, as a page can make without script reading anything.
  const frame = document.createElement("iframe");
  frame.name = "sink";
  document.body.append(frame);
  const form = document.createElement("form");
  form.method = "POST";
  form.action = stream + "/action";
  form.enctype = "text/plain";
  form.target = "sink";
  const input = document.createElement("input");
  input.name = '{"id":"signOut","x":"';
  input.value = '"}';
  form.append(input);
  document.body.append(form);
  form.submit();
  await new Promise((done) => setTimeout(done, 1000));
  note("done", true);
})();
</script>`;

let browser = null;
let hostileServer = null;
let timelineFile = null;
try {
  const worldLine = await until("The world's link", 180_000, () =>
    seen(/World: (\S+)/),
  );
  const link = /World: (\S+)/.exec(worldLine.line)[1];
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  check(
    /^[A-Za-z0-9_-]{24,}$/.test(token ?? ""),
    "the link carries a token after #",
  );
  check(
    !seen(/Opening|xdg-open/) &&
      lines.filter((l) => /World:/.test(l.line)).length === 1,
    "the command printed one link and opened no browser",
  );

  // A plain Chromium, as the person's own browser.
  browser = await chromium.launch({
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(link);

  const world = () =>
    page.evaluate(() => {
      const s = window.explorer.getState();
      return {
        time: s.time,
        playing: s.playing,
        live: s.live,
        duration: window.explorerWorld.timeline.duration,
        count: window.explorerLive.trace.events.length,
      };
    });
  const events = (from = 0) =>
    page.evaluate(
      (from) =>
        window.explorerLive.trace.events.slice(from).map((event, i) => ({
          event,
          at: window.explorerLive.trace.received[from + i],
        })),
      from,
    );
  const buttons = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll(".controls button[data-action]")].map(
          (b) => [b.dataset.action, !b.disabled],
        ),
      ),
    );

  // ------------------------------------------------------ still on load --

  await until("The world caught up", 120_000, async () => {
    const s = await world();
    return s.live?.caughtUp && s.live.connection === "open";
  });
  await until("The controls", 60_000, async () => {
    const b = await buttons();
    return b.signUp === true;
  });
  const first = await world();
  await sleep(2500);
  const still = await world();
  check(
    !first.playing &&
      !still.playing &&
      still.time === first.time &&
      Math.abs(first.time - first.duration) < 1e-6,
    `the world is still on load, at the present (${first.count} events, t=${first.time.toFixed(2)} s of ${first.duration.toFixed(2)} s)`,
  );

  // ----------------------------------------------------------- actions --

  const steps = [
    {
      id: "signUp",
      before: {
        signUp: true,
        signIn: false,
        signInWrongPassword: false,
        signOut: false,
        reload: true,
      },
    },
    {
      id: "reload",
      before: {
        signUp: false,
        signIn: false,
        signInWrongPassword: false,
        signOut: true,
        reload: true,
      },
    },
    {
      id: "signOut",
      before: {
        signUp: false,
        signIn: false,
        signInWrongPassword: false,
        signOut: true,
        reload: true,
      },
    },
    {
      id: "signInWrongPassword",
      before: {
        signUp: true,
        signIn: true,
        signInWrongPassword: true,
        signOut: false,
        reload: true,
      },
    },
    {
      id: "signIn",
      before: {
        signUp: true,
        signIn: true,
        signInWrongPassword: true,
        signOut: false,
        reload: true,
      },
    },
    {
      id: "signOut",
      before: {
        signUp: false,
        signIn: false,
        signInWrongPassword: false,
        signOut: true,
        reload: true,
      },
    },
  ];
  const delays = [];
  let played = false;
  for (const step of steps) {
    // Wait for the panel to settle into the state the page is in.
    let shown = null;
    try {
      await until(`The buttons before ${step.id}`, 10_000, async () => {
        shown = await buttons();
        return Object.entries(step.before).every(
          ([id, on]) => shown[id] === on,
        );
      });
      check(
        true,
        `before ${step.id}, the enabled buttons follow the page: ${Object.keys(
          step.before,
        )
          .filter((k) => step.before[k])
          .join(", ")}`,
      );
    } catch {
      check(
        false,
        `before ${step.id}, the buttons are ${JSON.stringify(shown)}, not ${JSON.stringify(step.before)}`,
      );
    }
    const from = (await world()).count;
    const pressedAt = Date.now();
    await page.click(`.controls button[data-action="${step.id}"]`);
    const end = await until(`The end of ${step.id}`, 40_000, async () =>
      (await events(from)).find(
        ({ event }) =>
          event.kind === "scenario" &&
          event.action === step.id &&
          event.status !== "start",
      ),
    );
    check(
      end.event.outcome === "ok",
      `${step.id} ended ${end.event.outcome}: ${end.event.result ?? end.event.error}`,
    );
    // The runs it caused reach the recorder after the page saw their results.
    let got;
    try {
      got = await until(`The runs of ${step.id}`, 10_000, async () => {
        const after = await events(from);
        const client = after.find(
          ({ event }) =>
            ["step", "http", "socket", "storage", "page"].includes(
              event.kind,
            ) &&
            event.runId == null &&
            event.kind !== "scenario",
        );
        const run = after.find(({ event }) => event.kind === "run");
        return client && run ? { client, run, after } : null;
      });
    } catch {
      got = null;
    }
    check(
      got !== null,
      `${step.id}: client events and function runs arrived in the world`,
    );
    if (got) {
      const start = got.after.find(
        ({ event }) => event.kind === "scenario" && event.status === "start",
      );
      delays.push({
        id: step.id,
        start: start.at - pressedAt,
        client: got.client.at - pressedAt,
        run: got.run.at - pressedAt,
        runSpan: got.run.at - (start.event.time ?? pressedAt),
      });
    }
    if (!played) played = (await world()).playing;
  }
  check(played, "what an action caused plays in the world");
  console.log("\nDelay from the press to the world (ms):");
  for (const d of delays)
    console.log(
      `  ${d.id.padEnd(20)} action start ${d.start}, first client event ${d.client}, first function run ${d.run}`,
    );

  // Scrubbing back over this session's events still works.
  const back = await page.evaluate(() => {
    const c = window.explorerWorld.timeline.chapters[0];
    window.explorer.getState().pause();
    window.explorer.getState().setTime(c.start + 0.1);
    return window.explorer.getState().time;
  });
  check(
    back < (await world()).duration,
    "the timeline can be dragged back over the session",
  );

  // ---------------------------------------------------- hostile tab --

  hostileServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" }).end(HOSTILE_PAGE);
  });
  await new Promise((done) =>
    hostileServer.listen(HOSTILE_PORT, "127.0.0.1", done),
  );
  const beforeHostile = (await world()).count;
  const hostile = await context.newPage();
  // Without the token, and with it, as if it had leaked.
  const results = {};
  for (const [name, query] of [
    ["no token", ""],
    ["with the token", `?token=${token}`],
  ]) {
    await hostile.goto(`http://localhost:${HOSTILE_PORT}/${query}`);
    await hostile.waitForFunction(() => window.results.done === true, null, {
      timeout: 20_000,
    });
    results[name] = await hostile.evaluate(() => window.results);
  }
  await sleep(2000);
  const afterHostile = await events(beforeHostile);
  const started = afterHostile.filter(({ event }) => event.kind === "scenario");
  check(
    started.length === 0,
    `another origin started no action (${started.length} action events)`,
  );
  for (const [name, r] of Object.entries(results)) {
    check(
      !/^read/.test(r.stream) && !/^read/.test(r.streamWithToken),
      `another origin, ${name}, cannot read the stream (${r.stream}, ${r.streamWithToken})`,
    );
    check(
      r.post === "refused",
      `another origin, ${name}, cannot post an action (${r.post}; no-cors: ${r.postNoCors}, form sent)`,
    );
  }
  const controlsAfter = await buttons();
  check(
    controlsAfter.signUp === true && controlsAfter.signOut === false,
    "the page is still signed out after the hostile tab",
  );
  await hostile.close();

  timelineFile = (() => {
    const found = seen(/timeline go to (\S+)/);
    return found
      ? join(/timeline go to (\S+)/.exec(found.line)[1], "run.ndjson")
      : null;
  })();
  // What the world received is the stream.
  const streamed = JSON.stringify(await events(0));
  const secrets = existsSync(secretsFile)
    ? readFileSync(secretsFile, "utf8").split("\n").filter(Boolean)
    : [];
  check(
    secrets.some((s) => s.startsWith("pw-")) &&
      secrets.some((s) => s.startsWith("eyJ")),
    `the check saw the generated password and the tokens (${secrets.length} secrets)`,
  );
  const leaked = secrets.filter((s) => streamed.includes(s));
  check(
    leaked.length === 0 && !streamed.includes("eyJ"),
    `no secret and no eyJ in the stream (${leaked.length} leaked)`,
  );
  globalThis.secretsSeen = secrets;
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  await new Promise((done) =>
    hostileServer ? hostileServer.close(done) : done(),
  );
  launcher.kill("SIGINT");
  const code = await Promise.race([
    exited,
    sleep(60_000).then(() => "timeout"),
  ]);
  check(code === 0, `the command stopped on Ctrl-C (exit ${code})`);
  if (timelineFile && existsSync(timelineFile)) {
    const text = readFileSync(timelineFile, "utf8");
    const secrets = globalThis.secretsSeen ?? [];
    check(
      !text.includes("eyJ") && !secrets.some((s) => text.includes(s)),
      "no secret and no eyJ in the timeline file",
    );
  } else {
    check(false, "the timeline file exists");
  }
  rmSync(scratch, { recursive: true, force: true });
  await sleep(500);
  const left = [...processes()].filter(
    ([pid, args]) =>
      !before.has(pid) &&
      /convex|vite|chrom|tsx|live\.mjs|playwright|explorer|esbuild|node -e/i.test(
        args,
      ) &&
      !/\bps\b/.test(args),
  );
  check(
    left.length === 0,
    `no process left${left.length ? `: ${left.map(([pid, args]) => `${pid} ${args.slice(0, 120)}`).join("; ")}` : ""}`,
  );
}

if (failures.length > 0) {
  console.log(`\nFAIL: ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS");
