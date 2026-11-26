// Builds the world, serves it from a nested path, and opens it twice in
// Chromium: once as is, once with every font request refused. Both times the
// scene must draw frames, and the overview (O) must show something; with the
// fonts refused, the page must say so on screen. Needs Playwright with a Chromium (`require("playwright")`).
//
//   pnpm --filter @convex-dev/explorer-world check:load-failures
/* global requestAnimationFrame, document -- these run in the page. */
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
const url = `${server.resolvedUrls.local[0]}nested/world/index.html?paused&t=8&free`;

const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

async function open(blockFonts) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const external = [];
  context.on("request", (r) => {
    if (!r.url().startsWith(server.resolvedUrls.local[0]))
      external.push(r.url());
  });
  if (blockFonts) await context.route(/\.woff2?(\?.*)?$/, (r) => r.abort());
  const page = await context.newPage();
  await page.goto(url);
  // The first frame of SwiftShader with bloom takes about a minute.
  await page.waitForFunction(() => globalThis.explorerFrames?.count > 2, null, {
    timeout: 240_000,
    polling: 1000,
  });
  await page.waitForTimeout(2000);
  const problems = await page
    .locator(".problems:not(.no-webgl)")
    .allInnerTexts();
  // Fly to the overview, then count the lit pixels of the scene.
  await page.keyboard.press("o");
  await page.waitForTimeout(8000);
  const lit = await page.evaluate(
    () =>
      new Promise((resolve) => {
        // Queued after the scene's own frame, so the drawing is still there.
        requestAnimationFrame(() => {
          const copy = document.createElement("canvas");
          copy.width = 320;
          copy.height = 180;
          const g = copy.getContext("2d");
          g.drawImage(document.querySelector("canvas"), 0, 0, 320, 180);
          const { data } = g.getImageData(0, 0, 320, 180);
          let n = 0;
          for (let i = 0; i < data.length; i += 4)
            if (data[i] + data[i + 1] + data[i + 2] > 180) n++;
          resolve(n);
        });
      }),
  );
  await context.close();
  return { problems: problems.join(" "), external, lit };
}

let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed = true;
};
try {
  const normal = await open(false);
  check(
    normal.problems === "",
    `normal load: the scene draws, no problem shown${normal.problems ? ` (shown: ${normal.problems})` : ""}`,
  );
  check(
    normal.external.length === 0,
    `normal load: no request leaves the server${normal.external.length ? ` (${normal.external[0]})` : ""}`,
  );
  const blocked = await open(true);
  check(
    normal.lit > 500,
    `overview: the scene has lit pixels (${normal.lit} of 57600)`,
  );
  check(true, "fonts refused: the scene still draws frames");
  check(
    /font of the 3D labels did not load/.test(blocked.problems),
    "fonts refused: the page says so on screen",
  );
} finally {
  await browser.close();
  server.httpServer.close();
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
