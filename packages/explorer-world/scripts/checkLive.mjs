// Checks live mode end to end: runs `explorer:live` on the username-password
// example with the recorder's scenario in place of a person, opens the world
// in a headless Chromium in place of the window a person would look at, and
// asserts:
//
// - events show in the world while the scenario is still running, and how
//   long after the page did something its event reached the world and was
//   drawn (the lag);
// - pause, scrubbing back, resume and "skip to live" work while events keep
//   arriving, and a rebuild does not move a paused playhead out of its run;
// - once the recording ends, the world equals the world of the saved file
//   (same runs, steps, writes, calls, page items and unplaced list), and it
//   received every line of the file;
// - after Ctrl-C (SIGINT to the command), no process it started is left.
//
// Needs the example's dependencies, `pnpm build` at the root, and Playwright
// with a Chromium (`require("playwright")`). Takes about two minutes.
//
//   pnpm --filter @convex-dev/explorer-world check:live
/* global setTimeout, URL, URLSearchParams -- Node globals. */
/* global window -- runs in the page. */
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(root, "../../examples/react-username-password");
const WORLD_PORT = 5274;
const STREAM_PORT = 5299;

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ms = (n) => `${Math.round(n)} ms`;
const quantile = (xs, q) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const stats = (xs) =>
  xs.length
    ? `median ${ms(quantile(xs, 0.5))}, p90 ${ms(quantile(xs, 0.9))}, max ${ms(Math.max(...xs))} (n=${xs.length})`
    : "none";

/** The processes now, by pid. */
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

const lines = [];
const launcher = spawn(
  process.execPath,
  [
    join(root, "scripts/live.mjs"),
    appDir,
    "--view",
    "islands",
    "--scenario",
    "react-username-password",
    "--browser",
    "chromium",
    "--no-open",
    "--world-port",
    String(WORLD_PORT),
    "--stream-port",
    String(STREAM_PORT),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
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
    await sleep(200);
  }
  throw new Error(`${what}: not within ${timeoutMs / 1000} s.`);
}

/**
 * Reads the stream from Node as the world's origin, and notes when each line
 * arrives: the latency of the recorder alone, without the page's main
 * thread, which software rendering keeps busy here.
 */
const streamArrivals = [];
/** The stream's path with its token, from the world's link once printed. */
let streamPath = null;
function readStream() {
  if (streamPath === null) {
    const world = seen(/World: (\S+)/);
    if (world) {
      const link = new URL(/World: (\S+)/.exec(world.line)[1]);
      const live = new URL(link.searchParams.get("live"));
      // The token is after `#` in the world's link.
      const token = new URLSearchParams(link.hash.slice(1)).get("token");
      streamPath = `${live.pathname}?token=${encodeURIComponent(token)}`;
    } else {
      setTimeout(readStream, 300);
      return;
    }
  }
  const req = request(
    {
      host: "127.0.0.1",
      port: STREAM_PORT,
      path: streamPath,
      headers: { Origin: `http://127.0.0.1:${WORLD_PORT}` },
    },
    (response) => {
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        const at = Date.now();
        buffer += chunk;
        const messages = buffer.split("\n\n");
        buffer = messages.pop();
        for (const message of messages) {
          const id = /^id: (\d+)$/m.exec(message);
          if (id) streamArrivals[Number(id[1])] = at;
        }
      });
    },
  );
  req.on("error", () => setTimeout(readStream, 300));
  req.end();
}
readStream();

let browser = null;
try {
  const worldLine = await until("The world's URL", 120_000, () =>
    seen(/World: (\S+)/),
  );
  const worldUrl = /World: (\S+)/.exec(worldLine.line)[1];

  // The world opens while the deployment starts, as it does for a person.
  browser = await chromium.launch({
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const external = [];
  page.on("request", (request) => {
    const { hostname } = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(hostname))
      external.push(request.url());
  });
  // The link ends in its token (`#token=`); the hooks go before it.
  const [linkBase, linkToken] = worldUrl.split("#");
  await page.goto(`${linkBase}&free&noeffects&capture#${linkToken}`);
  const state = () =>
    page.evaluate(() => {
      const s = window.explorer.getState();
      const w = window.explorerWorld;
      const at = w.stateAt(s.time);
      const chapters = w.timeline.chapters;
      return {
        time: s.time,
        playing: s.playing,
        live: s.live,
        duration: w.timeline.duration,
        chapters: chapters.length,
        chapterIndex: at.chapterIndex,
        chapterRun: at.chapter?.run.id ?? null,
        chapterStart: at.chapter?.start ?? null,
        lastStart: chapters.at(-1)?.start ?? null,
        received: window.explorerLive.trace.received.length,
        frames: window.explorerFrames.count,
      };
    });
  await until(
    "The world's first frame",
    120_000,
    async () => (await state()).frames > 0,
  );
  check(true, "the world drew its first frame");

  // ------------------------------------------------- live, mid-run --

  const opened = await until("The stream", 120_000, async () => {
    const s = await state();
    return s.live?.connection === "open" ? s : null;
  });
  const openedAt = Date.now();
  const framesAtOpen = opened.frames;
  check(
    true,
    `the world connected to the stream (${opened.received} events so far)`,
  );

  // Wait for a few runs while the scenario still runs.
  const midRun = await until("Six runs in the world", 120_000, async () => {
    const s = await state();
    return s.chapters >= 6 ? s : null;
  });
  const scenarioEnded = () => seen(/recorder: The scenario ended/);
  check(
    !scenarioEnded(),
    `runs show in the world while the scenario runs: ${midRun.chapters} runs, ${midRun.received} events, scenario not ended`,
  );

  // Scrub back to the second run, as dragging the bar does: pause, then seek.
  const target = await page.evaluate(() => {
    const c = window.explorerWorld.timeline.chapters[1];
    window.explorer.getState().pause();
    window.explorer.getState().setTime(c.start + 0.5);
    return c.run.id;
  });
  await sleep(500);
  const scrubbed = await state();
  const caption = await page.locator(".caption .run .n").textContent();
  check(
    scrubbed.chapterRun === target && caption?.trim() === "2",
    `scrubbing back shows the second run (caption ${caption?.trim()})`,
  );

  // Resume.
  await page.getByRole("button", { name: "Play" }).click();
  await sleep(1500);
  const resumed = await state();
  check(
    resumed.playing && resumed.time > scrubbed.time,
    `resume plays on from there (${scrubbed.time.toFixed(1)} s -> ${resumed.time.toFixed(1)} s)`,
  );
  const behindText = await page.locator(".live .lag").textContent();
  check(
    /behind/.test(behindText ?? ""),
    `the HUD says how far behind: "${behindText}"`,
  );

  // Skip to live.
  await page.getByRole("button", { name: "Skip to live" }).click();
  const skipped = await state();
  check(
    skipped.playing &&
      skipped.chapterIndex === skipped.chapters - 1 &&
      Math.abs(skipped.time - skipped.lastStart) < 0.5,
    `skip to live plays the newest run (run ${skipped.chapterIndex + 1} of ${skipped.chapters})`,
  );

  check(
    !scenarioEnded(),
    "scrub, resume and skip to live ran while the scenario ran",
  );

  // Pause: the playhead stays in its run while the timeline grows.
  await page.getByRole("button", { name: "Pause" }).click();
  const paused = await state();
  const offset = paused.time - (paused.chapterStart ?? 0);
  // The scenario waits about a minute for a refresh the page schedules; wait
  // until more runs come, and a little after.
  let endedWhilePaused = true;
  await until("More runs while paused", 120_000, async () => {
    const s = await state();
    endedWhilePaused = Boolean(scenarioEnded());
    return s.chapters > paused.chapters ? s : null;
  });
  check(
    !endedWhilePaused,
    "more runs came while paused, with the scenario still running",
  );
  await sleep(1000);
  const later = await state();
  check(!later.playing, "pause holds while events arrive");
  check(
    later.received > paused.received && later.duration > paused.duration,
    `events kept arriving while paused: ${paused.received} -> ${later.received} events, ${paused.chapters} -> ${later.chapters} runs`,
  );
  check(
    later.chapterRun === paused.chapterRun &&
      Math.abs(later.time - (later.chapterStart ?? 0) - offset) < 1e-6,
    `the paused playhead kept its place: run ${paused.chapterRun}, ${offset.toFixed(2)} s in`,
  );

  await page.getByRole("button", { name: "Skip to live" }).click();
  check((await state()).playing, "skip to live plays again after the pause");

  // ----------------------------------------------------------- end --

  const savedLine = await until("The end of the recording", 300_000, () =>
    seen(/saved in (\S+?)\.? The world/),
  );
  const out = /saved in (\S+?)\.? The world/.exec(savedLine.line)[1];
  await until("The end of the stream", 30_000, async () => {
    const s = await state();
    return s.live?.connection === "ended";
  });
  // The last rebuild.
  await sleep(500);
  const { frames: framesAtEnd } = await state();
  const frameMs =
    (Date.now() - openedAt) / Math.max(1, framesAtEnd - framesAtOpen);
  const text = readFileSync(out, "utf8");
  const fileLines = text.split("\n").filter((line) => line.trim() !== "");
  const result = await page.evaluate((ndjson) => {
    const live = window.explorerLive;
    return {
      same:
        JSON.stringify(live.summary()) ===
        JSON.stringify(live.summaryOf(ndjson)),
      summary: live.summary(),
      trace: live.trace,
    };
  }, text);
  check(
    result.trace.received.length === fileLines.length,
    `the world received every line of the file: ${result.trace.received.length} of ${fileLines.length}`,
  );
  check(
    result.same,
    `the live world equals the world of the saved file: ${result.summary.runs.length} runs, ` +
      `${result.summary.runs.reduce((n, r) => n + r.steps.length, 0)} steps, ` +
      `${result.summary.runs.reduce((n, r) => n + r.writes.length, 0)} writes, ` +
      `${result.summary.events.call?.seen ?? 0} calls, ${result.summary.unplaced.length} unplaced`,
  );

  // The lag: from when the page did something (the event's time, on this
  // machine's clock) to when its event reached the world, and to the first
  // frame drawn after the rebuild that held it. Only events made once the
  // world was connected and drawing.
  const events = fileLines.map((line) => JSON.parse(line));
  const { received, builds } = result.trace;
  const buildOf = (i) => builds.find((b) => b.events > i);
  const lag = {
    input: [],
    inputStream: [],
    inputDrawn: [],
    run: [],
    runStream: [],
    runDrawn: [],
    write: [],
    writeStream: [],
    call: [],
    callStream: [],
  };
  events.forEach((event, i) => {
    if (event.time < openedAt) return;
    const arrived = received[i] - event.time;
    const ready = (from) =>
      streamArrivals[i] === undefined ? [] : [streamArrivals[i] - from];
    const build = buildOf(i);
    const drawn = build?.drawnAt ? build.drawnAt - event.time : null;
    if (event.kind === "input") {
      lag.input.push(arrived);
      lag.inputStream.push(...ready(event.time));
      if (drawn !== null) lag.inputDrawn.push(drawn);
    } else if (event.kind === "run") {
      // A run's time is its start, on the deployment's clock (this machine's).
      lag.run.push(received[i] - event.endTime);
      lag.runStream.push(...ready(event.endTime));
      if (drawn !== null) lag.runDrawn.push(build.drawnAt - event.endTime);
    } else if (event.kind === "write" && !event.snapshot) {
      lag.write.push(arrived);
      lag.writeStream.push(...ready(event.time));
    } else if (event.kind === "call") {
      lag.call.push(received[i] - event.endTime);
      lag.callStream.push(...ready(event.endTime));
    }
  });
  console.log("From the recorder's stream, read in Node:");
  console.log(`  a person's action (input):      ${stats(lag.inputStream)}`);
  console.log(`  a run's end:                    ${stats(lag.runStream)}`);
  console.log(`  a write's commit:               ${stats(lag.writeStream)}`);
  console.log(`  a call's result in the page:    ${stats(lag.callStream)}`);
  console.log(
    `In the world (headless, software rendering: ${Math.round(frameMs)} ms a frame on average; ` +
      `a rebuild ${stats(builds.map((b) => b.ms))}):`,
  );
  console.log(
    `lag, a person's action (input) to the world:   ${stats(lag.input)}`,
  );
  console.log(
    `lag, input to its first frame drawn:            ${stats(lag.inputDrawn)}`,
  );
  console.log(
    `lag, a run's end to the world:                  ${stats(lag.run)}`,
  );
  console.log(
    `lag, a run's end to its first frame drawn:      ${stats(lag.runDrawn)}`,
  );
  console.log(
    `lag, a write's commit to the world:             ${stats(lag.write)}`,
  );
  console.log(
    `lag, a call's result in the page to the world:  ${stats(lag.call)}`,
  );
  check(
    lag.inputStream.length > 0 && quantile(lag.inputStream, 0.5) < 100,
    `a person's action leaves the recorder's stream within 100 ms (median ${ms(quantile(lag.inputStream, 0.5) ?? NaN)})`,
  );
  check(
    lag.writeStream.length > 0 && quantile(lag.writeStream, 0.5) < 500,
    `a write leaves the recorder's stream within 500 ms of its commit (median ${ms(quantile(lag.writeStream, 0.5) ?? NaN)})`,
  );
  // Loose: software rendering here takes hundreds of ms a frame.
  check(
    lag.input.length > 0 && quantile(lag.input, 0.5) < 3000,
    `a person's action reaches the world within 3 s here (median ${ms(quantile(lag.input, 0.5) ?? NaN)})`,
  );
  check(
    external.length === 0,
    `the world requested nothing from elsewhere${external.length ? `: ${external[0]}` : ""}`,
  );
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  // Ctrl-C.
  launcher.kill("SIGINT");
  const code = await Promise.race([
    exited,
    sleep(60_000).then(() => "timeout"),
  ]);
  check(code === 0, `the command stopped on Ctrl-C (exit ${code})`);
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
