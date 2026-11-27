// Checks that the camera stays where the viewer put it. Runs `explorer:live`
// on the username-password example, opens the world in a headless Chromium,
// and for each way of moving the camera (the wheel, a drag, the keys) moves
// it, presses a control of the panel, waits for what the control causes
// (which can lay the map out again and mount the scene afresh), and asserts
// that the camera has not moved. Also: a forced remount of the scene leaves
// the camera where it is, Home moves it, and a resize refits Home only while
// the camera is still at Home.
//
//   pnpm --filter @convex-dev/explorer-world check:camera-stays
//
// `CHECK_LOG=<file>` uses a command already running whose output is in that
// file instead of starting one. The link is never printed: it holds the
// run's token.
/* global setTimeout -- Node globals. */
/* global window, document -- run in the page. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = resolve(root, "../../examples/react-username-password");

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let launcher = null;
let output = "";
async function worldLink() {
  if (process.env.CHECK_LOG) {
    const m = readFileSync(process.env.CHECK_LOG, "utf8").match(
      /World: (http\S+)/,
    );
    if (!m) throw new Error("No world link in CHECK_LOG.");
    return m[1];
  }
  const env = { ...process.env };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  launcher = spawn(
    process.execPath,
    [join(root, "scripts/live.mjs"), appDir, "--browser", "chromium"],
    { stdio: ["ignore", "pipe", "pipe"], env },
  );
  const add = (chunk) => (output += chunk.toString());
  launcher.stdout.on("data", add);
  launcher.stderr.on("data", add);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const m = output.match(/World: (http\S+)/);
    if (m) return m[1];
    if (launcher.exitCode !== null)
      throw new Error(`The command exited:\n${output.slice(-2000)}`);
    await sleep(200);
  }
  throw new Error("No world link within 240 s.");
}

let browser = null;
try {
  const link = await worldLink();
  browser = await chromium.launch({
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 810 },
  });
  await page.goto(link);
  await page.waitForFunction(() => !!window.explorerControls, null, {
    timeout: 60_000,
  });
  await sleep(15_000);

  const pose = () =>
    page.evaluate(() => {
      const c = window.explorerControls;
      const v = (o) => [o.x, o.y, o.z];
      // Where it is now, not where it is headed.
      const P = c.getPosition(c.camera.position.clone(), false);
      const T = c.getTarget(c.camera.position.clone(), false);
      return { position: v(P), target: v(T) };
    });
  const layouts = () =>
    page.evaluate(() => window.explorer.getState().layoutVersion);
  const far = (a, b) =>
    Math.max(
      ...a.position.map((x, i) => Math.abs(x - b.position[i])),
      ...a.target.map((x, i) => Math.abs(x - b.target[i])),
    );
  const show = (p) => p.position.map((x) => x.toFixed(1)).join(", ");
  /** Waits until the camera has stopped moving. */
  const settle = async () => {
    let last = await pose();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const now = await pose();
      if (far(now, last) < 1e-3) return now;
      last = now;
    }
    return last;
  };
  const centre = { x: 720, y: 380 };
  /** Presses a control once it is enabled; waits for what it causes. */
  const press = async (action) => {
    const button = page.locator(`.controls button[data-action="${action}"]`);
    await button.waitFor();
    await page.waitForFunction(
      (a) =>
        !document.querySelector(`.controls button[data-action="${a}"]`)
          ?.disabled,
      action,
      { timeout: 60_000 },
    );
    const before = await page.evaluate(
      () => window.explorerWorld.timeline.actions?.length ?? 0,
    );
    await button.click();
    await page.mouse.move(centre.x, centre.y);
    // The action, then what the world does about it.
    await page
      .waitForFunction(
        (n) => (window.explorerWorld.timeline.actions?.length ?? 0) > n,
        before,
        { timeout: 30_000 },
      )
      .catch(() => {});
    await sleep(6_000);
  };
  const stays = async (how, move, action) => {
    await page.mouse.move(centre.x, centre.y);
    await move();
    const moved = await settle();
    const v0 = await layouts();
    await press(action);
    const after = await settle();
    const v1 = await layouts();
    check(
      far(moved, after) < 0.01,
      `${how}, then ${action}: the camera stays (${show(moved)} → ${show(after)}; the map was laid out again ${v1 - v0} time(s))`,
    );
  };

  const opened = await settle();
  await stays(
    "zoomed in with the wheel",
    async () => {
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -300);
        await sleep(120);
      }
    },
    "signUp",
  );
  check(
    far(opened, await pose()) > 1,
    "the wheel moved the camera away from where it opened",
  );
  await stays(
    "dragged",
    async () => {
      await page.mouse.move(centre.x, centre.y);
      await page.mouse.down();
      await page.mouse.move(centre.x - 160, centre.y + 60, { steps: 12 });
      await page.mouse.up();
    },
    "signOut",
  );
  await stays(
    "flown with the keys",
    async () => {
      await page.keyboard.down("d");
      await sleep(500);
      await page.keyboard.up("d");
    },
    "signIn",
  );
  await stays("left as it is (a second press)", async () => {}, "reload");

  // A remount of the scene, as a live re-layout does, whatever caused it.
  const beforeRemount = await settle();
  await page.evaluate(() =>
    window.explorer.setState((s) => ({ layoutVersion: s.layoutVersion + 1 })),
  );
  await sleep(1500);
  check(
    far(beforeRemount, await settle()) < 0.01,
    `the scene mounted afresh: the camera stays (${show(beforeRemount)} → ${show(await pose())})`,
  );

  // Home moves it, and a resize refits Home while the camera is there.
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.press("h");
  const home = await settle();
  check(
    far(home, beforeRemount) > 1,
    `Home (H) moves the camera (${show(home)})`,
  );
  await page.setViewportSize({ width: 1100, height: 810 });
  const refitted = await settle();
  check(
    far(home, refitted) > 0.01,
    "at Home, a resize of the window refits Home",
  );
  await page.mouse.wheel(0, -300);
  const away = await settle();
  await page.setViewportSize({ width: 1440, height: 810 });
  check(
    far(away, await settle()) < 0.01,
    "moved away from Home, a resize leaves the camera",
  );
  // After a remount at Home, Home is not flown again.
  await page.keyboard.press("h");
  const home2 = await settle();
  await page.mouse.wheel(0, -300);
  const away2 = await settle();
  await page.evaluate(() =>
    window.explorer.setState((s) => ({ layoutVersion: s.layoutVersion + 1 })),
  );
  await sleep(1500);
  check(
    far(away2, await settle()) < 0.01 && far(home2, away2) > 0.01,
    "a remount after Home does not fly Home again",
  );
} catch (error) {
  check(false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close();
  if (launcher) {
    if (launcher.exitCode === null) {
      const exited = new Promise((done) => launcher.on("exit", done));
      launcher.kill("SIGINT");
      await exited;
    }
  }
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
