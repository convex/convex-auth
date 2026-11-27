// Builds the world, serves it from a nested path, and checks in Chromium, at
// device pixel ratio 1 and 2, from the overview, mid range and close up:
//
// - the scene buffer, read back as half floats before any effect, holds no
//   NaN, infinite or negative pixel (sampled a few times, as sparkles move);
// - the final frame, with bloom and vignette, has no large black area where
//   the same view without effects has content: the bloom spreads one bad
//   pixel over a black rectangle;
// - the safety net holds: with a quad that outputs NaN, the scene buffer has
//   non-finite pixels and the frame still shows the world; without the
//   sanitize pass the same quad blacks the frame out, so the check can see it.
//
// SwiftShader is not a GPU: a GPU can turn an operation into NaN where it
// gives a finite value, so passing here does not prove a GPU draws right.
// `?diag` shows the same scan on any machine. Needs Playwright with a
// Chromium (`require("playwright")`).
//
//   pnpm --filter @convex-dev/explorer-world check:rendering
/* global requestAnimationFrame, document, explorerDiag, explorerControls, explorerWorld -- these run in the page. */
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
  build: { outDir: join(out, "nested", "world") },
});
const server = await preview({
  root,
  preview: { port: 0, host: "127.0.0.1" },
  build: { outDir: out },
});
const url = `${server.resolvedUrls.local[0]}nested/world/index.html?paused&t=8&free&capture`;

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

/** The frame on screen, as the luminance of a grid of blocks. */
const frameBlocks = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const W = 64;
          const H = 36;
          const copy = document.createElement("canvas");
          copy.width = W;
          copy.height = H;
          const g = copy.getContext("2d");
          g.drawImage(document.querySelector("canvas"), 0, 0, W, H);
          const { data } = g.getImageData(0, 0, W, H);
          const lum = [];
          for (let i = 0; i < data.length; i += 4)
            lum.push(data[i] + data[i + 1] + data[i + 2]);
          resolve(lum);
        });
      }),
  );

/** Blocks black with effects that have content without them. */
function blackedOut(withEffects, without) {
  let n = 0;
  for (let i = 0; i < without.length; i++)
    if (without[i] > 45 && withEffects[i] < 6) n++;
  return n;
}

const setEffects = async (page, on) => {
  await page.evaluate((on) => {
    const s = explorerDiag.state.getState();
    s.toggle("bloom", on);
    s.toggle("vignette", on);
  }, on);
  await page.waitForTimeout(2500);
};

async function run(dpr) {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 600 },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  await page.goto(url);
  // The first frame of SwiftShader with bloom takes about a minute.
  await page.waitForFunction(
    () => globalThis.explorerFrames?.count > 2 && globalThis.explorerControls,
    null,
    { timeout: 240_000, polling: 1000 },
  );
  const views = await page.evaluate(() => {
    const { position: P, target: T } = explorerWorld.layout.overview;
    const toward = (k) => P.map((p, i) => T[i] + (p - T[i]) * k);
    return {
      overview: { position: P, target: T },
      "mid range": { position: toward(0.4), target: T },
      "close up": { position: toward(0.08), target: T },
    };
  });
  for (const [name, at] of Object.entries(views)) {
    await page.evaluate(({ position: p, target: t }) => {
      explorerControls.setLookAt(...p, ...t, false);
    }, at);
    await page.waitForTimeout(1500);
    const scans = [];
    for (let i = 0; i < 4; i++) {
      scans.push(await page.evaluate(() => explorerDiag.scan()));
      await page.waitForTimeout(300);
    }
    const bad = scans.reduce((n, s) => n + s.nonFinite, 0);
    const negative = scans.reduce((n, s) => n + s.negative, 0);
    check(
      bad === 0 && negative === 0,
      `dpr ${dpr}, ${name}: no non-finite or negative pixel in the scene buffer (${bad} non-finite, ${negative} negative in 4 scans of ${scans[0].width}×${scans[0].height})`,
    );
    const lit = await frameBlocks(page);
    await setEffects(page, false);
    const plain = await frameBlocks(page);
    await setEffects(page, true);
    const content = plain.filter((l) => l > 45).length;
    const lost = blackedOut(lit, plain);
    check(
      content > 50 && lost <= content * 0.01,
      `dpr ${dpr}, ${name}: the frame with effects keeps the content of the frame without (${lost} of ${content} blocks black)`,
    );
  }

  // The safety net: a quad that outputs NaN, in the middle of the overview.
  const { position, target } = views.overview;
  await page.evaluate(
    ({ position: p, target: t }) => {
      explorerControls.setLookAt(...p, ...t, false);
      const quad = explorerDiag.inject(true);
      quad.position.set(t[0], t[1] + 5, t[2]);
      quad.lookAt(...p);
    },
    { position, target },
  );
  await page.waitForTimeout(2500);
  const injected = await page.evaluate(() => explorerDiag.scan());
  check(
    injected.nonFinite > 0,
    `dpr ${dpr}, NaN quad: the scan sees it (${injected.nonFinite} non-finite pixels)`,
  );
  const guarded = await frameBlocks(page);
  await setEffects(page, false);
  const plain = await frameBlocks(page);
  await page.evaluate(() =>
    explorerDiag.state.getState().toggle("sanitize", false),
  );
  await setEffects(page, true);
  const unguarded = await frameBlocks(page);
  const content = plain.filter((l) => l > 45).length;
  const lostGuarded = blackedOut(guarded, plain);
  const lostUnguarded = blackedOut(unguarded, plain);
  check(
    lostGuarded <= content * 0.01,
    `dpr ${dpr}, NaN quad: the sanitize pass keeps the frame (${lostGuarded} of ${content} blocks black)`,
  );
  check(
    lostUnguarded > content * 0.1,
    `dpr ${dpr}, NaN quad without the sanitize pass: the check sees the black area (${lostUnguarded} of ${content} blocks black)`,
  );
  await context.close();
}

try {
  await run(1);
  await run(2);
} finally {
  await browser.close();
  server.httpServer.close();
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
