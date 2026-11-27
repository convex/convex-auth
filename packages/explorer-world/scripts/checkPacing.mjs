// Checks the pacing of live mode with a person pressing the controls: runs
// `explorer:live` on the username-password example with no display, opens
// the world in a headless Chromium, and asserts:
//
// - one pressed control plays out in at most MAX_SPAN seconds of shown
//   time, and the playhead reaches the live edge (the world at rest and up
//   to date) within that span plus SLACK seconds of wall time after the
//   control's work ended;
// - three controls pressed in a row, each as soon as it is enabled: the
//   playhead is never more than one pressed control behind, and after the
//   last one it reaches the live edge within the same bound.
//
// SLACK covers the software renderer of a headless browser, whose frames
// are slow; on a real GPU the playhead keeps shown time.
//
// Needs the example's dependencies, `pnpm build` at the root, and Playwright
// with a Chromium (`require("playwright")`). Takes about two minutes.
//
//   pnpm --filter @convex-dev/explorer-world check:pacing
/* global setTimeout -- Node globals. */
/* global window, document -- run in the page. */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(root, "../../examples/react-username-password");
const WORLD_PORT = 5474;
const STREAM_PORT = 5499;
/** The longest shown time one pressed control may take, start to rest (s). */
const MAX_SPAN = 12;
/** Wall seconds allowed past the shown span, for slow headless frames. */
const SLACK = 8;

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

const env = { ...process.env };
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

let browser = null;
try {
  const worldLine = await until("The world's link", 180_000, () =>
    seen(/World: (\S+)/),
  );
  const link = /World: (\S+)/.exec(worldLine.line)[1];
  browser = await chromium.launch({
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  await page.goto(link);

  /** The playhead, the timeline's pressed controls, and how far behind. */
  const world = () =>
    page.evaluate(() => {
      const s = window.explorer.getState();
      const tl = window.explorerWorld.timeline;
      return {
        time: s.time,
        duration: tl.duration,
        actions: tl.actions,
        actionEnds: tl.actionEnds,
        caughtUp: s.live?.caughtUp,
        // Pressed controls that start after the playhead.
        ahead: tl.actions.filter((a) => a > s.time + 1e-3).length,
      };
    });
  const enabled = (id) =>
    page.evaluate(
      (id) =>
        document.querySelector(`.controls button[data-action="${id}"]`)
          ?.disabled === false,
      id,
    );
  const atRest = async () => {
    const s = await world();
    return s.duration - s.time < 0.05 && s.ahead === 0;
  };

  await until("The world caught up", 120_000, async () => {
    const s = await world();
    return s.caughtUp;
  });

  /**
   * Presses `ids` in a row, each as soon as it is enabled; then waits for
   * the playhead to reach the live edge. Samples how many pressed controls
   * the playhead was behind, every 200 ms.
   */
  const press = async (ids) => {
    const from = (await world()).actions.length;
    let mostAhead = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        mostAhead = Math.max(mostAhead, (await world()).ahead);
        await sleep(200);
      }
    })();
    for (const id of ids) {
      await until(`${id} enabled`, 30_000, () => enabled(id));
      const n = (await world()).actionEnds.length;
      await page.click(`.controls button[data-action="${id}"]`);
      // Its work is done when its end reaches the world.
      await until(`the end of ${id}`, 40_000, async () => {
        const s = await world();
        return s.actionEnds.length > n;
      });
    }
    const doneAt = Date.now();
    const s = await world();
    const last = s.actions.length - 1;
    // The shown span of the last control: from its start to the end of the
    // timeline as it is when its work was done.
    const span = s.duration - s.actions[last];
    let restAt = null;
    try {
      await until("the live edge", (span + SLACK) * 1000, atRest);
      restAt = Date.now();
    } catch {
      // Reported below.
    }
    sampling = false;
    await sampler;
    return {
      pressed: s.actions.length - from,
      span,
      wall: restAt === null ? null : (restAt - doneAt) / 1000,
      mostAhead,
    };
  };

  const one = await press(["signUp"]);
  check(
    one.pressed === 1,
    `one pressed control is one action in the timeline (${one.pressed})`,
  );
  check(
    one.span <= MAX_SPAN,
    `sign up plays out in ${one.span.toFixed(1)} s of shown time (at most ${MAX_SPAN})`,
  );
  check(
    one.wall !== null,
    `after sign up, the playhead reached the live edge ${one.wall === null ? "not" : `${one.wall.toFixed(1)} s`} after its work ended (at most ${(one.span + SLACK).toFixed(1)})`,
  );

  const three = await press(["signOut", "signIn", "signOut"]);
  check(
    three.pressed === 3,
    `three pressed controls are three actions (${three.pressed})`,
  );
  check(
    three.mostAhead <= 1,
    `pressed in a row, the playhead was never more than one action behind (at most ${three.mostAhead} ahead of it)`,
  );
  check(
    three.span <= MAX_SPAN,
    `the last of them plays out in ${three.span.toFixed(1)} s of shown time (at most ${MAX_SPAN})`,
  );
  check(
    three.wall !== null,
    `after the last, the playhead reached the live edge ${three.wall === null ? "not" : `${three.wall.toFixed(1)} s`} after its work ended (at most ${(three.span + SLACK).toFixed(1)})`,
  );
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
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
