// Builds the world, serves it from a nested path, and opens it twice in
// Chromium: once as is, once with every font request refused. Both times the
// scene must draw frames; with the fonts refused, the page must say so on
// screen. Needs Playwright with a Chromium (`require("playwright")`).
//
//   pnpm --filter @convex-dev/explorer-world check:load-failures
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
  await context.close();
  return { problems: problems.join(" "), external };
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
