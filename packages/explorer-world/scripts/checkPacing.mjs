// Checks the pacing of live mode with a person pressing the controls: runs
// `explorer:live` on the username-password example with no display, opens
// the world in a headless Chromium, and asserts:
//
// - one pressed control plays out in at most MAX_SPAN seconds of shown
//   time (sign-up, which loads the page again before it signs in, in
//   MAX_SPAN_SIGN_UP), and the playhead reaches the live edge (the world at rest and up
//   to date) within that span plus SLACK seconds of wall time after the
//   control's work ended;
// - three controls pressed in a row, each as soon as it is enabled: the
//   playhead is never more than one pressed control behind, and after the
//   last one it reaches the live edge within the same bound; the sign-in
//   among them, with the token fetch that follows it, plays out in at most
//   MAX_SPAN_SIGN_IN;
// - every operation's body takes at least MIN_HOP seconds to go from one
//   place to the next (MIN_HOP_KEY between a module and a storage key in
//   it): seven places in a third of a second is a flash, not a path.
//
// The page is drawn at double density, so that the software renderer of a
// headless browser draws slow frames: shown time must follow the wall clock
// all the same (a slow machine drops frames, not time). SLACK covers the
// time from a control's press to its work's end, and polling.
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
/** The same for sign-in with the token fetch that follows it (s). */
const MAX_SPAN_SIGN_IN = 13;
/** The same for sign-up, which loads the page again first (s). */
const MAX_SPAN_SIGN_UP = 16.5;
/** The least shown time of a body's hop between two places (s); `HOP` in `model/operations.ts`. */
const MIN_HOP = 0.33;
/** The same between a module and a storage key in it (s); `HOP_KEY`. */
const MIN_HOP_KEY = 0.28;
/** Wall seconds allowed past the shown span, for slow headless frames. */
const SLACK = 3;

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
    await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    })
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
    one.span <= MAX_SPAN_SIGN_UP,
    `sign up plays out in ${one.span.toFixed(1)} s of shown time (at most ${MAX_SPAN_SIGN_UP})`,
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

  // Each action from its start to the end of the last thing that started
  // before it was done, the body of an operation included.
  const spans = await page.evaluate(() => {
    const tl = window.explorerWorld.timeline;
    const things = [
      ...tl.movements.map((m) => [m.start, m.end]),
      ...tl.clientSteps.map((c) => [c.start, c.end]),
      ...tl.ops.map((o) => [o.points[0].at, o.points.at(-1).at]),
    ];
    return tl.actions.map((start, i) => {
      const done = tl.actionEnds[i];
      const ends = things
        .filter(([s]) => s >= start && s <= done)
        .map(([, e]) => e);
      return Math.max(done, ...ends) - start;
    });
  });
  check(
    spans.length === 4 && spans[2] <= MAX_SPAN_SIGN_IN,
    `sign in, with its token fetch, plays out in ${spans[2]?.toFixed(1)} s of shown time (at most ${MAX_SPAN_SIGN_IN}; each action: ${spans.map((x) => x.toFixed(1)).join(", ")} s)`,
  );

  const hops = await page.evaluate(() =>
    // What the client did by itself between pressed controls plays at
    // half the hops (BRIEF in model/schedule.ts).
    window.explorerWorld.timeline.ops
      .filter((op) => !op.unasked)
      .flatMap((op) =>
        op.points.slice(1).flatMap((b, i) => {
          const a = op.points[i];
          if (a.anchor === b.anchor) return [];
          const key = [a.anchor, b.anchor].some((x) =>
            x.startsWith("storageKey:"),
          );
          return [
            {
              key,
              gap: b.at - a.at,
              what: `${op.kind}: ${a.step} → ${b.step}`,
            },
          ];
        }),
      ),
  );
  const short = hops.filter(
    (h) => h.gap < (h.key ? MIN_HOP_KEY : MIN_HOP) - 1e-6,
  );
  check(
    hops.length > 20 && short.length === 0,
    `each of ${hops.length} hops of a body takes at least ${MIN_HOP} s (${MIN_HOP_KEY} s to or from a storage key)${
      short.length
        ? `; shorter: ${short
            .slice(0, 5)
            .map((h) => `${h.what} ${h.gap.toFixed(3)} s`)
            .join(", ")}`
        : ""
    }`,
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
