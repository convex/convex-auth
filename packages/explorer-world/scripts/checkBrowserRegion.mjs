// Builds the world, serves it, and checks the browser region in Chromium on
// the saved recording of a real scripted sign-up and sign-in
// (`projects/convex-auth/recording-page.ndjson`, made by `explorer:live
// --scenario react-username-password`):
//
// - every step the page's client library reported plays, and while it plays
//   it lights the module that reported it; a storage step also lights the
//   key it names, the same key as the storage event of that name;
// - the page's sign-in state goes through what was reported;
// - nothing in the browser region moves without an event behind it: at rest
//   (between beats, and at the end), two frames a second apart are the same,
//   paused and playing.
//
// Needs Playwright with a Chromium (`require("playwright")`).
//
//   pnpm --filter @convex-dev/explorer-world check:browser
/* global explorer, explorerControls, explorerWorld -- these run in the page. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "explorer-world-"));
await build({
  root,
  base: "./",
  logLevel: "warn",
  build: { outDir: join(out, "world") },
});
const server = await preview({
  root,
  preview: { port: 0, host: "127.0.0.1" },
  build: { outDir: out },
});
const url = `${server.resolvedUrls.local[0]}world/index.html?recording=page&paused&capture&free`;

let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed = true;
};

// What the recording holds, read from the file itself.
const events = readFileSync(
  join(root, "projects/convex-auth/recording-page.ndjson"),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const reported = events.filter((e) => e.kind === "step" && e.from === "page");
const storageKeys = new Set(
  events.filter((e) => e.kind === "storage").map((e) => e.key),
);

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
try {
  const page = await (
    await browser.newContext({ viewport: { width: 1000, height: 600 } })
  ).newPage();
  page.on("pageerror", (e) =>
    check(false, `no error in the page (${e.message})`),
  );
  await page.goto(url);
  await page.waitForFunction(
    () => globalThis.explorerFrames?.count > 2 && globalThis.explorerControls,
    null,
    { timeout: 240000, polling: 1000 },
  );

  // Every reported step plays, lighting its module and its key.
  const steps = await page.evaluate(() => {
    const w = explorerWorld;
    const items = w.recording.runs
      .flatMap((r) => [...r.before, ...r.after])
      .filter((i) => i.kind === "step")
      .sort((a, b) => a.time - b.time);
    return w.timeline.clientSteps.map((c, i) => {
      const s = w.stateAt((c.start + c.end) / 2);
      const item = items[i];
      return {
        part: c.part,
        step: c.step,
        lit: [...s.active.keys()],
        lights: item?.lights ?? [],
        itemStep: item?.step,
        placed: (item?.lights ?? []).every((id) => w.layout.parts.has(id)),
      };
    });
  });
  check(
    steps.length === reported.length,
    `every step the page reported plays (${steps.length} of ${reported.length})`,
  );
  const order = reported
    .slice()
    .sort(
      (a, b) =>
        a.time - b.time ||
        Number(a.id.split("#").pop()) - Number(b.id.split("#").pop()),
    );
  const wrong = steps.filter(
    (s, i) =>
      s.part !== order[i]?.part ||
      s.step !== order[i]?.step ||
      !s.lit.includes(s.part) ||
      !s.placed,
  );
  check(
    wrong.length === 0,
    `each lights the module that reported it, in the order reported (${wrong.length} wrong${wrong.length ? `: ${JSON.stringify(wrong[0])}` : ""})`,
  );
  const storage = order
    .map((e, i) => ({ e, s: steps[i] }))
    .filter(({ e }) => e.step.startsWith("storage."));
  const offKey = storage.filter(({ e, s }) => {
    const key = `${e.detail.key}_${e.detail.namespace}`;
    const id = `storageKey:${key}`;
    return !s.lit.includes(id) || !s.lights.includes(id);
  });
  check(
    storage.length > 0 && offKey.length === 0,
    `each of the ${storage.length} storage steps lands on its key (${offKey.length} off)`,
  );
  const named = new Set(
    storage.map(({ e }) => `${e.detail.key}_${e.detail.namespace}`),
  );
  check(
    [...named].every((k) => storageKeys.has(k)),
    "every key a storage step names is a key the storage events show",
  );

  // The sign-in state goes through what was reported.
  const states = await page.evaluate(() =>
    explorerWorld.timeline.states.map((s) => s.state),
  );
  check(
    ["signedOut", "signingIn", "signedIn", "error"].every((s) =>
      states.includes(s),
    ),
    `the page's sign-in state goes through signed out, signing in, signed in and error (${[...new Set(states)].join(", ")})`,
  );

  // At rest, nothing moves: two frames a second apart are the same.
  await page.evaluate(() => {
    const h = explorerWorld.layout.home;
    explorerControls.setLookAt(...h.position, ...h.target, false);
  });
  const rests = await page.evaluate(() => {
    const tl = explorerWorld.timeline;
    // A moment between two beats where nothing is moving, and the end.
    const quiet = [];
    for (let i = 1; i < tl.beats.length && quiet.length < 2; i++) {
      const t = tl.beats[i - 1].end + 0.05;
      const s = explorerWorld.stateAt(t);
      if (t < tl.beats[i].start && !s.travellers.length && !s.active.size)
        quiet.push(t);
    }
    return [...quiet, tl.duration];
  });
  for (const [k, t] of rests.entries()) {
    await page.evaluate((t) => explorer.getState().setTime(t), t);
    await page.waitForTimeout(2500);
    const a = await page.screenshot();
    await page.waitForTimeout(1000);
    const b = await page.screenshot();
    check(
      a.equals(b),
      `at rest (t=${t.toFixed(1)} s, paused) two frames a second apart are the same`,
    );
    if (k === rests.length - 1) {
      // Playing at the end, as a live world waits at its edge: there is
      // nothing left to play, so nothing moves. (Play on a saved recording
      // starts over, so the state is set directly.)
      await page.evaluate(() => explorer.setState({ playing: true }));
      await page.waitForTimeout(1500);
      const c = await page.screenshot();
      await page.waitForTimeout(1000);
      const d = await page.screenshot();
      check(c.equals(d), "playing at the end, nothing moves");
    }
  }
} finally {
  await browser.close();
  server.httpServer.close();
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
