// Builds the world, serves it, and checks the camera in Chromium with the
// pointer: a plain drag pans, keeping the point of the ground pressed under
// the pointer, at the overview and at a flat tilt, and selects nothing even
// when pressed on an island; Cmd-drag orbits and selects nothing; a click in
// place selects, and a click on empty space clears. Needs Playwright with a
// Chromium (`require("playwright")`).
//
//   pnpm --filter @convex-dev/explorer-world check:camera
/* global explorer, explorerCamera, explorerControls, explorerWorld -- these run in the page. */
import { mkdtempSync, rmSync } from "node:fs";
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
const W = 1000;
const H = 600;

let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed = true;
};

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
    await browser.newContext({ viewport: { width: W, height: H } })
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
  await page.waitForTimeout(3000);
  // The ground point (y=0) under a screen point, and where a world point is on screen.
  const ground = (x, y) =>
    page.evaluate(
      ([x, y, W, H]) => {
        const cam = explorerCamera;
        const p = cam.position.clone();
        const d = p
          .clone()
          .set((x / W) * 2 - 1, -(y / H) * 2 + 1, 0.5)
          .unproject(cam)
          .sub(p)
          .normalize();
        const t = -p.y / d.y;
        return [p.x + d.x * t, 0, p.z + d.z * t];
      },
      [x, y, W, H],
    );
  const screen = (q) =>
    page.evaluate(
      ([q, W, H]) => {
        const v = explorerCamera.position
          .clone()
          .set(...q)
          .project(explorerCamera);
        return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H];
      },
      [q, W, H],
    );
  const onScreenIsland = () =>
    page.evaluate(
      ([W, H]) => {
        let best = null;
        for (const i of explorerWorld.layout.islands) {
          if (i.parentIsland) continue;
          const v = explorerCamera.position
            .clone()
            .set(...i.position)
            .project(explorerCamera);
          const d = Math.hypot(v.x - 0.1, v.y + 0.1);
          if (
            v.z < 1 &&
            Math.abs(v.x) < 0.5 &&
            v.y < 0.5 &&
            v.y > -0.3 &&
            (!best || d < best.d)
          )
            best = {
              d,
              x: ((v.x + 1) / 2) * W,
              y: ((1 - v.y) / 2) * H,
              id: i.id,
            };
        }
        return best;
      },
      [W, H],
    );
  const sel = () =>
    page.evaluate(() => JSON.stringify(explorer.getState().selected));
  const drag = async (from, path, mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.move(...from);
    await page.mouse.down();
    let at = from;
    for (const to of path) {
      for (let i = 1; i <= 12; i++)
        await page.mouse.move(
          at[0] + ((to[0] - at[0]) * i) / 12,
          at[1] + ((to[1] - at[1]) * i) / 12,
        );
      at = to;
    }
    await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
    await page.waitForTimeout(1500);
    return at;
  };
  // The world opens at Home; these drags are checked from the overview.
  await page.evaluate(() => {
    const { position: P, target: T } = explorerWorld.layout.overview;
    explorerControls.setLookAt(...P, ...T, false);
  });
  await page.waitForTimeout(1200);
  for (const tilt of ["overview", "flat"]) {
    if (tilt === "flat") {
      await page.evaluate(() => explorerControls.rotatePolarTo(1.25, false));
      await page.waitForTimeout(1500);
    }
    for (const [name, rel] of [
      ["left 300", [[-300, 0]]],
      ["up 200", [[0, -200]]],
      [
        "diagonal",
        [
          [-150, -100],
          [120, 90],
        ],
      ],
    ]) {
      await page.evaluate(() => {
        const T = explorerWorld.layout.overview.target;
        explorerControls.moveTo(T[0], T[1], T[2], false);
      });
      await page.waitForTimeout(1200);
      const isl = await onScreenIsland();
      // Select something else first so a stray click would show.
      await page.evaluate(() => explorer.getState().select(null));
      const from = [isl.x, isl.y];
      const g = await ground(...from);
      const path = [];
      let acc = from;
      for (const r of rel) {
        acc = [acc[0] + r[0], acc[1] + r[1]];
        path.push(acc);
      }
      const end = await drag(from, path);
      const s = await screen(g);
      const off = Math.hypot(s[0] - end[0], s[1] - end[1]);
      const selected = await sel();
      check(
        off < 3 && selected === "null",
        `${tilt}, drag ${name} pressed on ${isl.id}: the pressed ground point stays under the pointer (${off.toFixed(1)} px off) and nothing is selected (${selected})`,
      );
    }
  }
  // Cmd-drag pressed on an island
  await page.evaluate(() => explorer.getState().select(null));
  let isl = await onScreenIsland();
  const az0 = await page.evaluate(() => explorerControls.azimuthAngle);
  await drag([isl.x, isl.y], [[isl.x - 100, isl.y]], ["Meta"]);
  const az1 = await page.evaluate(() => explorerControls.azimuthAngle);
  const afterOrbit = await sel();
  check(
    Math.abs(az1 - az0) > 0.2 && afterOrbit === "null",
    `Cmd-drag pressed on ${isl.id} orbits (azimuth ${az0.toFixed(2)} -> ${az1.toFixed(2)}) and selects nothing (${afterOrbit})`,
  );
  // Click without movement
  isl = await onScreenIsland();
  await page.mouse.click(isl.x, isl.y);
  await page.waitForTimeout(1500);
  const clicked = await sel();
  check(clicked !== "null", `a click without movement selects (${clicked})`);
  await page.mouse.click(5, 300);
  await page.waitForTimeout(1500);
  const cleared = await sel();
  check(
    cleared === "null",
    `a click on empty space clears the selection (${cleared})`,
  );
} finally {
  await browser.close();
  server.httpServer.close();
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
