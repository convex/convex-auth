// Checks the stage end to end: runs `explorer:live` on the username-password
// example as a person would (the stage in the recorder's one window, with no
// scenario), and uses that window over its DevTools port the way a person
// does: real pointer clicks and keyboard on the page on the screen. It
// asserts:
//
// - the window is the stage, with the app's page in its screen frame, and
//   nothing moves and nothing is used until the check acts;
// - sign up, reload (the stage's button), sign out and sign in, typed into
//   the page on the screen, are recorded from that frame only, and show on
//   the floor: the elements used, tokens landing in localStorage and
//   leaving it, messages on the WebSocket, the page's documents over HTTP;
// - the time handle: dragged back and forth with the pointer, the stage
//   shows the same thing at the same time in both directions; let go at the
//   right end, it is live again;
// - replay: the Replay control opens a saved recording, which plays and can
//   be paused and dragged; Live returns;
// - the password typed is in neither the timeline nor the stream;
// - after Ctrl-C (SIGINT to the command), no process it started is left.
//
// The window needs a display: without one (no DISPLAY), the command runs
// under xvfb-run. Needs the example's dependencies, `pnpm build` at the
// root, and Playwright with a Chromium (`require("playwright")`). About two
// minutes. Screenshots go to $STAGE_SHOTS when it is set.
//
//   pnpm --filter @convex-dev/explorer-world check:stage
/* global setTimeout, URL -- Node globals. */
/* global explorerStage, explorerCamera, innerWidth, innerHeight -- run in the page. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(root, "../../examples/react-username-password");
const WORLD_PORT = 5474;
const STREAM_PORT = 5499;
const DEBUG_PORT = 9433;
const shots = process.env.STAGE_SHOTS ?? null;

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

const command = [
  join(root, "scripts/live.mjs"),
  appDir,
  "--browser",
  "chromium",
  "--world-port",
  String(WORLD_PORT),
  "--stream-port",
  String(STREAM_PORT),
  "--debug-port",
  String(DEBUG_PORT),
];
const display = !!process.env.DISPLAY;
const [bin, args] = display
  ? [process.execPath, command]
  : [
      "xvfb-run",
      ["-a", "-s", "-screen 0 1600x1000x24", process.execPath, ...command],
    ];
const lines = [];
const launcher = spawn(bin, args, {
  stdio: ["ignore", "pipe", "pipe"],
  detached: !display,
});
const exited = new Promise((done) => launcher.on("exit", (code) => done(code)));
let pending = "";
const onOutput = (chunk) => {
  pending += chunk.toString();
  const parts = pending.split("\n");
  pending = parts.pop();
  for (const line of parts) {
    lines.push(line);
    console.log(`  | ${line}`);
  }
};
launcher.stdout.on("data", onOutput);
launcher.stderr.on("data", onOutput);
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
const password = `pw-${Math.random().toString(36).slice(2)}Zq7`;
try {
  await until("the command is ready", 240_000, () =>
    lines.some((l) => /use the app on the stage's screen/.test(l)),
  );
  const runDir = /logs and the timeline go to (\S+)/.exec(
    lines.find((l) => /timeline go to/.test(l)) ?? "",
  )?.[1];

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  check(context.pages().length === 1, "the command opened one window");
  const page = context.pages()[0];
  check(/\/stage\.html\?/.test(page.url()), "the window is the stage");
  const external = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
      external.push(r.url());
  });
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const screen = () =>
    page.frames().find((f) => f.name() === "explorer-screen");
  await until("the page shows on the screen", 60_000, async () => {
    const f = screen();
    return f && (await f.locator("#username").count()) > 0;
  });
  await until("the stage drew", 60_000, () =>
    page.evaluate(() => explorerStage.frames.count > 10),
  );
  await sleep(1500);
  const quiet = await page.evaluate(() => {
    const ev = explorerStage.feed.events;
    const s = explorerStage.store.getState();
    return {
      inputs: ev.filter((e) => e.kind === "input").length,
      scenario: ev.filter((e) => e.kind === "scenario").length,
      mode: s.clock.mode,
      source: s.source.kind,
      pages: ev.filter((e) => e.kind === "page").length,
    };
  });
  check(
    quiet.inputs === 0 && quiet.scenario === 0,
    `nothing is used on load (inputs ${quiet.inputs}, scenario steps ${quiet.scenario})`,
  );
  check(
    quiet.mode === "live" && quiet.source === "live",
    "the stage opens live",
  );
  check(
    quiet.pages > 0,
    `the page's frame is recorded (${quiet.pages} page events)`,
  );
  await shot("stage-0-load");

  // A person: real pointer clicks and the keyboard, on the screen.
  const type = async (selector, text) => {
    await screen().locator(selector).click();
    await page.keyboard.type(text, { delay: 30 });
  };
  const signedIn = () => screen().getByRole("button", { name: "Sign out" });
  const at = {};
  await screen()
    .getByRole("link", { name: /sign up/i })
    .click();
  await screen().waitForURL(/signup/);
  const username = `stage-${Date.now().toString(36)}`;
  await type("#username", username);
  await type("#password", password);
  at.signUp = Date.now();
  await screen().locator("button[type=submit]").click();
  await sleep(300);
  await shot("stage-1-sign-up");
  await signedIn().waitFor({ timeout: 30_000 });
  await sleep(2500);
  at.reload = Date.now();
  await page.getByRole("button", { name: "Reload the page" }).click();
  await sleep(300);
  await shot("stage-2-reload");
  await until("signed in after the reload", 30_000, async () => {
    const f = screen();
    return f && (await f.getByRole("button", { name: "Sign out" }).count()) > 0;
  });
  await sleep(2500);
  at.signOut = Date.now();
  await signedIn().click();
  await sleep(250);
  await shot("stage-3-sign-out");
  await screen().waitForURL(/login/);
  await sleep(2500);
  await type("#username", username);
  await type("#password", password);
  at.signIn = Date.now();
  await screen().locator("button[type=submit]").click();
  await sleep(300);
  await shot("stage-4-sign-in");
  await signedIn().waitFor({ timeout: 30_000 });
  await sleep(3000);
  await shot("stage-5-signed-in");

  // The camera, as in the islands world, and the inspector.
  const project = (x, yy, z) =>
    page.evaluate(([x, yy, z]) => explorerStage.project(x, yy, z), [x, yy, z]);
  const selection = () =>
    page.evaluate(() => explorerStage.store.getState().selection);
  const from = await project(-10, 0, 10);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 220, from.y - 60, { steps: 12 });
  await page.mouse.up();
  await sleep(700);
  const after = await project(-10, 0, 10);
  check(
    Math.hypot(after.x - (from.x - 220), after.y - (from.y - 60)) < 4 &&
      (await selection()) === null,
    `a drag on the floor pans, holding the point pressed under the pointer (${Math.round(after.x - from.x + 220)}, ${Math.round(after.y - from.y + 60)} px off), and selects nothing`,
  );
  const L = await page.evaluate(() => explorerStage.layout.LOCAL);
  const tray = await project(L.x + L.w * 0.35, L.h, L.z + L.d * 0.35);
  await page.mouse.click(tray.x, tray.y);
  await sleep(400);
  const picked = await selection();
  const inspector = await page
    .locator(".stage-inspector")
    .innerText()
    .catch(() => "");
  check(
    picked?.type === "thing" &&
      picked.id === "local" &&
      /localStorage/.test(inspector),
    `a click on localStorage opens the inspector on it (${JSON.stringify(picked)})`,
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Face the screen" }).click();
  await sleep(2500);
  const S = await page.evaluate(() => explorerStage.layout.SCREEN);
  const corners = await Promise.all(
    [
      [S.center[0] - S.width / 2, S.center[1] + S.height / 2],
      [S.center[0] + S.width / 2, S.center[1] - S.height / 2],
    ].map(([x, yy]) => project(x, yy, S.center[2])),
  );
  const size = await page.evaluate(() => [innerWidth, innerHeight]);
  const fill = Math.max(
    (corners[1].x - corners[0].x) / size[0],
    (corners[1].y - corners[0].y) / size[1],
  );
  const inside = corners.every(
    (c) => c.x >= -1 && c.y >= -1 && c.x <= size[0] + 1 && c.y <= size[1] + 1,
  );
  check(
    inside && fill > 0.85,
    `Face the screen shows all of it, square on, filling ${Math.round(fill * 100)}% of the window`,
  );
  await shot("stage-5b-facing");
  await page.getByRole("button", { name: "Step back" }).click();
  await sleep(2500);
  const pos = await page.evaluate(() => explorerCamera.position.toArray());
  const home = await page.evaluate(
    () => explorerStage.layout.DEFAULT_VIEW.position,
  );
  check(
    Math.hypot(pos[0] - home[0], pos[1] - home[1], pos[2] - home[2]) < 1,
    `Step back returns to the whole stage (${pos.map((v) => v.toFixed(1)).join(", ")})`,
  );

  // What the recorder captured, and what the floor holds.
  const seen = await page.evaluate((marks) => {
    const ev = explorerStage.feed.events;
    const m = explorerStage.model();
    const by = {};
    for (const e of ev) by[e.kind] = (by[e.kind] ?? 0) + 1;
    const after = (t) => ev.filter((e) => e.time >= t);
    const storage = ev.filter((e) => e.kind === "storage");
    return {
      by,
      inputsWithRect: ev.filter((e) => e.kind === "input" && e.target.rect)
        .length,
      inputs: ev.filter((e) => e.kind === "input").length,
      documents: ev.filter(
        (e) => e.kind === "http" && e.resourceType === "document",
      ).length,
      documentsAfterReload: after(marks.reload).filter(
        (e) => e.kind === "http" && e.resourceType === "document",
      ).length,
      tokensSet: storage.filter(
        (e) => e.op === "set" && e.value && typeof e.value === "object",
      ).length,
      plainTokens: storage.filter(
        (e) => e.op === "set" && typeof e.value === "string",
      ).length,
      removedAfterSignOut: storage.filter(
        (e) =>
          e.op === "remove" && e.time >= marks.signOut && e.time < marks.signIn,
      ).length,
      socketSent: ev.filter(
        (e) => e.kind === "socket" && e.direction === "sent",
      ).length,
      stageHttp: ev.filter(
        (e) => e.kind === "http" && new URL(e.url).port === String(5474),
      ).length,
      elements: m.elements.map((e) => e.label),
      pageSteps: m.steps.length,
      stepParts: [...new Set(m.steps.map((x) => x.part))],
      firstStep: m.steps[0]?.time ?? null,
      storageStep: m.steps.find((x) => x.storageKey)?.time ?? null,
      exits: m.exits.map((e) => e.label),
      flights: m.flights.length,
      storageTimes: storage.map((e) => [e.op, e.time]),
      socketTimes: ev
        .filter((e) => e.kind === "socket" && e.direction === "sent")
        .map((e) => e.time),
    };
  }, at);
  console.log(`     recorded: ${JSON.stringify(seen.by)}`);
  check(
    seen.inputs >= 8 && seen.inputsWithRect === seen.inputs,
    `the person's actions are recorded, each with its element's place (${seen.inputs})`,
  );
  check(
    seen.documents >= 2 && seen.documentsAfterReload >= 1,
    `the page's documents are recorded, the reload's too (${seen.documents})`,
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
    seen.socketSent > 5,
    `the WebSocket's messages (${seen.socketSent} sent)`,
  );
  check(
    seen.elements.includes("username") && seen.elements.includes("password"),
    `the elements used stand on the page (${seen.elements.join(", ")})`,
  );

  check(
    seen.pageSteps > 0,
    `the client library's steps are recorded from the page (${seen.pageSteps}, in ${seen.stepParts.join(", ")})`,
  );
  if (seen.firstStep !== null) {
    const lit = await page.evaluate(
      ({ first, storage }) => {
        const { store } = explorerStage;
        store.getState().hold(first + 100);
        const a = explorerStage.now();
        const parts = [...a.parts.entries()].filter(([, p]) => p.lit > 0);
        let keys = [];
        if (storage !== null) {
          store.getState().hold(storage + 100);
          keys = [...explorerStage.now().keys.entries()].filter(
            ([, k]) => k.lit > 0,
          );
        }
        store.getState().goLive();
        return { parts: parts.map(([id]) => id), keys: keys.map(([k]) => k) };
      },
      { first: seen.firstStep, storage: seen.storageStep },
    );
    check(
      lit.parts.length > 0,
      `100 ms after a step, its module is lit (${lit.parts.join(", ")})`,
    );
    check(
      seen.storageStep === null || lit.keys.length > 0,
      `a storage step lights the key it names (${lit.keys.join(", ")})`,
    );
  }

  // The floor at chosen times: a function of the time.
  const firstSet = seen.storageTimes.find(([op]) => op === "set")[1];
  const firstRemove = seen.storageTimes.find(([op]) => op === "remove")[1];
  const firstSent = seen.socketTimes.find((t) => t > at.signIn);
  const probe = await page.evaluate(
    ({ firstSet, firstRemove, firstSent }) => {
      const { store } = explorerStage;
      const look = (t) => {
        store.getState().hold(t);
        const s = explorerStage.now();
        return {
          local: s.local.map((x) => [
            x.slot.name,
            x.leaving,
            +x.settled.toFixed(2),
          ]),
          flights: s.flights.length,
        };
      };
      return {
        before: look(firstSet - 50),
        landing: look(firstSet + 300),
        leaving: look(firstRemove + 300),
        flying: look(firstSent + 350),
      };
    },
    { firstSet, firstRemove, firstSent },
  );
  check(
    probe.before.local.length === 0 || firstSet - 50 < 0,
    "before the first token, localStorage holds nothing of it",
  );
  check(
    probe.landing.local.some(
      ([, leaving, settled]) => !leaving && settled > 0 && settled < 1,
    ),
    `300 ms after a token is set, it is landing (${JSON.stringify(probe.landing.local)})`,
  );
  check(
    probe.leaving.local.some(([, leaving]) => leaving),
    `300 ms after a token is removed, it is leaving (${JSON.stringify(probe.leaving.local)})`,
  );
  check(
    probe.flying.flights > 0,
    `350 ms after a message is sent, it is on its way (${probe.flying.flights} in flight)`,
  );
  await page.evaluate(() => explorerStage.store.getState().goLive());

  // The time handle, dragged with the pointer.
  const track = page.locator(".stage-track");
  let box = await track.boundingBox();
  const y = box.y + box.height / 2;
  const xAt = (k) => box.x + box.width * k;
  const sign = () =>
    page.evaluate(() => {
      const s = explorerStage.now();
      return JSON.stringify([
        s.path,
        s.elements.map((e) => [e.element.key, +e.lit.toFixed(3)]),
        s.local.map((x) => [x.held.eventId, x.leaving, +x.settled.toFixed(3)]),
        s.flights.map((f) => [f.flight.id, +f.along.toFixed(3)]),
      ]);
    });
  const heldTime = () =>
    page.evaluate(() => {
      const c = explorerStage.store.getState().clock;
      return c.mode === "held" ? c.time : null;
    });
  // Drags the handle through `steps` (fractions of the track), and says
  // whether the time followed it and whether each place, passed again,
  // showed the same thing (only where the track does not grow: a replay).
  const drag = async (steps, same) => {
    await page.mouse.move(xAt(steps[0]), y);
    await page.mouse.down();
    const seenAt = new Map();
    const times = [];
    let repeats = 0;
    let equal = 0;
    for (const k of steps) {
      await page.mouse.move(xAt(k), y, { steps: 4 });
      await sleep(120);
      const t = await heldTime();
      times.push(t);
      const s = await sign();
      if (seenAt.has(k)) {
        repeats++;
        const [t0, s0] = seenAt.get(k);
        if (Math.abs(t0 - t) < 1 && s0 === s) equal++;
      } else seenAt.set(k, [t, s]);
    }
    const turn = steps.indexOf(Math.min(...steps));
    check(
      times.every((t) => t !== null) &&
        times.slice(0, turn + 1).every((t, i, a) => i === 0 || t < a[i - 1]) &&
        times.slice(turn).every((t, i, a) => i === 0 || t > a[i - 1]),
      "the time follows the handle back and forward",
    );
    if (same)
      check(
        repeats > 0 && equal === repeats,
        `dragged back and forth, each place shows the same as before (${equal}/${repeats})`,
      );
  };
  await drag([0.9, 0.7, 0.5, 0.3, 0.15, 0.3, 0.5, 0.7, 0.9], false);
  await shot("stage-6-dragged");
  await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
  await page.mouse.up();
  await sleep(200);
  const mode = await page.evaluate(
    () => explorerStage.store.getState().clock.mode,
  );
  check(mode === "live", `let go at the right end, it is live (${mode})`);

  // Replay a saved recording.
  await page.getByRole("button", { name: "Replay" }).click();
  await page.getByRole("menuitem", { name: /Saved: page/ }).click();
  await sleep(1500);
  const replay = await page.evaluate(() => {
    const s = explorerStage.store.getState();
    const t0 = explorerStage.now().time;
    return {
      source: s.source.kind,
      mode: s.clock.mode,
      t0,
      start: explorerStage.model().start,
    };
  });
  check(
    replay.source === "replay" && replay.mode === "playing",
    "Replay opens a saved recording and plays it",
  );
  await sleep(1000);
  const t1 = await page.evaluate(() => explorerStage.now().time);
  check(t1 > replay.t0, "the replay moves on");
  await page.getByRole("button", { name: "Pause" }).click();
  const p1 = await page.evaluate(() => explorerStage.now().time);
  await sleep(600);
  const p2 = await page.evaluate(() => explorerStage.now().time);
  check(p1 === p2, "Pause holds the replay");
  // The track is shorter in a replay, beside its Play button.
  box = await track.boundingBox();
  await drag([0.95, 0.8, 0.6, 0.45, 0.3, 0.1, 0.3, 0.45, 0.6, 0.8, 0.95], true);
  await page.mouse.up();
  await page.mouse.click(xAt(0.6), y);
  await sleep(300);
  await shot("stage-7-replay");
  const held = await page.evaluate(() => {
    const m = explorerStage.model();
    return (explorerStage.now().time - m.start) / (m.end - m.start);
  });
  check(
    Math.abs(held - 0.6) < 0.03,
    `a click on the track moves the replay there (${held.toFixed(3)})`,
  );
  await page.getByRole("button", { name: /Live/ }).click();
  const back = await page.evaluate(
    () => explorerStage.store.getState().source.kind,
  );
  check(back === "live", "Live returns to the live page");
  check(
    external.length === 0,
    `the stage requested nothing from elsewhere${external.length ? `: ${external[0]}` : ""}`,
  );

  // No secret in what was recorded.
  const streamed = await page.evaluate(() =>
    JSON.stringify(explorerStage.feed.events),
  );
  check(!streamed.includes(password), "the password is not in the stream");
  await browser.close();
  browser = null;
  if (display) launcher.kill("SIGINT");
  else process.kill(-launcher.pid, "SIGINT");
  const code = await Promise.race([
    exited,
    sleep(60_000).then(() => "timeout"),
  ]);
  check(code === 0 || !display, `the command stopped on Ctrl-C (exit ${code})`);
  const file = runDir ? readFileSync(join(runDir, "run.ndjson"), "utf8") : "";
  check(
    file.length > 0,
    `the timeline was saved (${file.split("\n").length} lines)`,
  );
  check(!file.includes(password), "the password is not in the timeline");
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  if (launcher.exitCode === null) {
    try {
      if (display) launcher.kill("SIGINT");
      else process.kill(-launcher.pid, "SIGINT");
    } catch {
      // Already gone.
    }
    await Promise.race([exited, sleep(60_000)]);
  }
  await sleep(1500);
  const left = [...processes()].filter(
    ([pid, args]) =>
      !before.has(pid) &&
      /convex|vite|chrom|tsx|live\.mjs|playwright|explorer|esbuild|Xvfb|node -e/i.test(
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
console.log("\nAll stage checks passed.");
process.exit(0);
