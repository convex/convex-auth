/**
 * Checks on a running deployment that the recorder keeps the first function
 * run after it starts: starts the recorder, runs one function, stops the
 * recorder, and looks for the run in the timeline. Repeats `--times` times.
 *
 * ```sh
 * pnpm --filter @convex-dev/explorer check:first-run <app directory> \
 *   --function auth:isAuthenticated --args '{}' [--times 3] [-- <record flags>]
 * ```
 *
 * In `--args`, `{n}` becomes a fresh number, for functions that need unique
 * input. Flags after `--` go to the recorder, e.g. `--cloud`.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const separator = process.argv.indexOf("--");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2, separator === -1 ? undefined : separator),
  allowPositionals: true,
  options: {
    function: { type: "string" },
    args: { type: "string", default: "{}" },
    times: { type: "string", default: "3" },
  },
});
const recordFlags = separator === -1 ? [] : process.argv.slice(separator + 1);
if (positionals.length !== 1 || values.function === undefined) {
  console.error(
    "Usage: check:first-run <app directory> --function <name> [--args <json>] [--times <n>] [-- <record flags>]",
  );
  process.exit(2);
}
const appDir = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]);
const fn = values.function;
const dir = mkdtempSync(join(tmpdir(), "explorer-check-"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let failures = 0;
for (let attempt = 1; attempt <= Number(values.times); attempt++) {
  const out = join(dir, `run${attempt}.ndjson`);
  // One process, so that SIGINT reaches the recorder itself.
  const recorder = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", appDir, "--out", out, ...recordFlags],
    {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  recorder.stderr.on("data", (chunk) => (stderr += chunk));
  const ready = Date.now();
  while (!stderr.includes("Recording;")) {
    if (Date.now() - ready > 60_000 || recorder.exitCode !== null) {
      console.error(stderr);
      throw new Error("The recorder did not start.");
    }
    await sleep(200);
  }
  const args = values.args.replaceAll("{n}", String(Date.now()));
  const run = spawnSync("npx", ["convex", "run", fn, args], {
    cwd: appDir,
    stdio: "ignore",
  });
  if (run.status !== 0) {
    throw new Error(`npx convex run ${fn} failed.`);
  }
  // The recorder holds events for 3 s before it writes them.
  await sleep(5000);
  const exited = new Promise((done) => recorder.on("exit", done));
  recorder.kill("SIGINT");
  await exited;
  const runs = readFileSync(out, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; identifier?: string })
    .filter((event) => event.kind === "run");
  const found = runs.filter((event) => event.identifier === fn).length;
  const ok = found === 1 && runs.length === 1;
  failures += ok ? 0 : 1;
  console.log(
    `${ok ? "ok" : "FAIL"} ${attempt}: ${runs.length} runs, ${found} of ${fn}`,
  );
}
process.exit(failures === 0 ? 0 : 1);
