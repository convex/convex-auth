// Builds the gallery of looks (`looks.html`), serves it, and checks in
// Chromium, at 1600×900, for every look and for the contact sheet:
//
// - the page throws no error and logs none;
// - the scene buffer, read back as half floats before any effect, holds no
//   NaN or infinite pixel;
// - the frame on screen is not black: enough of it has content, and it is
//   not one flat colour;
// - the camera stays where it is when the look changes (keys 1 to 9);
// - the vast sample (a look with its own scene) draws each of its levels
//   (keys F, B, A, J) the same way, and the motion at three points.
//
// SwiftShader is not a GPU: passing does not prove that a GPU draws right.
// Needs Playwright with a Chromium (`require("playwright")`).
//
//   pnpm --filter @convex-dev/explorer-world check:looks
/* global document, requestAnimationFrame, looksDiag, looksFrames, looksControls, looksIds, looksGallery, looksWorld -- these run in the page. */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "explorer-looks-"));
await build({
  root,
  base: "./",
  logLevel: "warn",
  build: {
    outDir: out,
    emptyOutDir: true,
    rollupOptions: { input: { looks: join(root, "looks.html") } },
  },
});
const server = await preview({
  root,
  preview: { port: 0, host: "127.0.0.1" },
  build: { outDir: out },
});
const base = `${server.resolvedUrls.local[0]}looks.html`;

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed = true;
};

/** Each canvas on the page, as the luminance of a grid of blocks. */
const canvasBlocks = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(
            [...document.querySelectorAll("canvas")].map((canvas) => {
              const W = 64;
              const H = 36;
              const copy = document.createElement("canvas");
              copy.width = W;
              copy.height = H;
              const g = copy.getContext("2d");
              g.drawImage(canvas, 0, 0, W, H);
              const { data } = g.getImageData(0, 0, W, H);
              const lum = [];
              for (let i = 0; i < data.length; i += 4)
                lum.push(data[i] + data[i + 1] + data[i + 2]);
              return lum;
            }),
          );
        });
      }),
  );

/** Whether a frame shows something: lit blocks, and more than one colour. */
function content(lum) {
  const lit = lum.filter((l) => l > 45).length / lum.length;
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const spread = Math.sqrt(
    lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length,
  );
  // A dark look lights little of the frame; a frame the bloom blacked out
  // lights almost none of it.
  return { ok: lit > 0.08 && spread > 12, lit, spread };
}

const framesNow = (page) => page.evaluate(() => looksFrames.count);
/** Waits for a few new frames, then for the scene to settle. */
async function settle(page, settleMs = 4000) {
  const start = await framesNow(page);
  await page.waitForFunction((n) => looksFrames.count > n + 3, start, {
    timeout: 300_000,
    polling: 500,
  });
  await page.waitForTimeout(settleMs);
}

const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${base}?capture&t=4.95`);
// The first frame of SwiftShader with bloom can take a minute.
await page.waitForFunction(
  () => globalThis.looksFrames?.count > 2 && globalThis.looksControls,
  null,
  { timeout: 300_000, polling: 1000 },
);
await page.waitForTimeout(3000);
const ids = await page.evaluate(() => looksIds);
const world = await page.evaluate(() => looksWorld);
check(ids.length >= 7, `${ids.length} looks`);
check(world.some(Boolean), "one look draws the vast sample");

/** The scene buffer holds no non-finite pixel, and the frame is not black. */
async function drawsClean(name) {
  const scans = [];
  for (let k = 0; k < 2; k++) {
    scans.push(await page.evaluate(() => looksDiag.scan()));
    await page.waitForTimeout(300);
  }
  const bad = scans.reduce((n, s) => n + s.nonFinite, 0);
  check(
    bad === 0,
    `${name}: no non-finite pixel in the scene buffer (${bad} in 2 scans of ${scans[0].width}×${scans[0].height})`,
  );
  const [lum] = await canvasBlocks(page);
  const c = content(lum);
  check(
    c.ok,
    `${name}: the frame is not black (${Math.round(c.lit * 100)}% lit, spread ${c.spread.toFixed(0)})`,
  );
}

// Move the camera away from the start, to see that it stays when the look changes.
await page.evaluate(() => looksControls.setLookAt(6, 12, 26, 2, 4, -2, false));
await settle(page, 1500);
const before = await page.evaluate(() => {
  const p = looksControls.camera.position;
  return [p.x, p.y, p.z];
});

for (let i = 0; i < ids.length; i++) {
  if (i > 0) {
    await page.keyboard.press(String(i + 1));
    await settle(page);
  }
  const shown = await page.evaluate(() => looksGallery.getState().view);
  check(shown === i, `key ${i + 1} shows ${ids[i]}`);
  if (world[i]) {
    // Its own scene and camera: each level, then the motion at three points.
    for (const [key, view] of [
      ["f", "far"],
      ["b", "browser"],
      ["a", "authClient"],
      ["j", "jwt"],
    ]) {
      await page.keyboard.press(key);
      await settle(page, 6000);
      const at = await page.evaluate(() => {
        const p = looksControls.camera.position;
        return [p.x, p.y, p.z];
      });
      check(
        Number.isFinite(at[0]),
        `${ids[i]}, key ${key.toUpperCase()}: at ${view} (${at.map((x) => x.toFixed(0)).join(", ")})`,
      );
      await drawsClean(`${ids[i]} at ${view}`);
    }
    await page.keyboard.press("b");
    for (const t of [1.2, 5.0, 9.4]) {
      await page.evaluate((t) => looksGallery.getState().setTime(t), t);
      await settle(page, 2500);
      await drawsClean(`${ids[i]} at ${t} s`);
    }
    continue;
  }
  const scans = [];
  for (let k = 0; k < 2; k++) {
    scans.push(await page.evaluate(() => looksDiag.scan()));
    await page.waitForTimeout(300);
  }
  const bad = scans.reduce((n, s) => n + s.nonFinite, 0);
  check(
    bad === 0,
    `${ids[i]}: no non-finite pixel in the scene buffer (${bad} in 2 scans of ${scans[0].width}×${scans[0].height})`,
  );
  const [lum] = await canvasBlocks(page);
  const c = content(lum);
  check(
    c.ok,
    `${ids[i]}: the frame is not black (${Math.round(c.lit * 100)}% lit, spread ${c.spread.toFixed(0)})`,
  );
  const at = await page.evaluate(() => {
    const p = looksControls.camera.position;
    return [p.x, p.y, p.z];
  });
  const moved = Math.hypot(...at.map((x, k) => x - before[k]));
  check(
    moved < 0.05,
    `${ids[i]}: the camera stayed where it was (moved ${moved.toFixed(3)})`,
  );
}

// The contact sheet: every look of the small sample, side by side.
const sheetIds = ids.filter((_, i) => !world[i]);
await page.keyboard.press("0");
await settle(page, 15_000);
const sheet = await canvasBlocks(page);
check(
  sheet.length === sheetIds.length,
  `the contact sheet shows ${sheet.length} canvases`,
);
sheet.forEach((lum, i) => {
  const c = content(lum);
  check(
    c.ok,
    `contact sheet, ${sheetIds[i]}: not black (${Math.round(c.lit * 100)}% lit, spread ${c.spread.toFixed(0)})`,
  );
});
check(
  errors.length === 0,
  `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`,
);

await browser.close();
await server.close();
rmSync(out, { recursive: true, force: true });
if (failed) process.exit(1);
