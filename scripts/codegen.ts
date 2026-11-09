#!/usr/bin/env tsx
// Regenerates every `_generated` directory in the monorepo.
//
// The apps and the components are found on disk, thus a new example app or a
// new component is picked up without a change to this script:
//
//   - An app is a workspace package that has a Convex functions directory
//     (`convex/` by default, or the `functions` field of its `convex.json`),
//     other than the component host below.
//   - A component is any other directory that has a `convex.config.ts` file.
//
// `convex codegen` analyzes a deployment. Every app and every component
// generates its code against one deployment that this script owns: the
// anonymous local deployment of `scripts/codegen-host`. This script finds the
// apps and the components, and runs `convex dev --once` in the host with
// `scripts/codegenTasks.ts` as its `--start` command. That file passes the URL
// and the admin key of the deployment to each `convex codegen`. With those two
// flags, the CLI reads no environment variable and no `.env.local`, thus a
// developer can point an example at any deployment (self-hosted, cloud, or one
// that is not running) without breaking codegen.
//
// `tsx` runs this file, and `pnpm typecheck` checks it against
// `scripts/tsconfig.json`: `tsx` strips the types, it does not check them.
//
// Usage: pnpm codegen [--list] [filter ...]
//
// A filter is a substring of a path. Only the apps and the components whose
// path contains one of the filters are regenerated.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodegenTask } from "./codegenTasks.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The app that owns the deployment every codegen runs against, described in
// `scripts/codegen-host/README.md`. It is a workspace package, thus discovery
// finds it like any other app; it generates no code of its own, thus the app
// list leaves it out.
const componentHost = join(root, "scripts", "codegen-host");

// The directories that hold the workspace packages. `pnpm-workspace.yaml` uses
// one `<dir>/*` glob for each of them.
const workspaceRoots = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
  .split("\n")
  .map((line) => /^\s*-\s*"?([^"\s]+)\/\*"?\s*$/.exec(line)?.[1])
  .filter((dir) => dir !== undefined);

// Dot-directories are skipped too, e.g. the docs build's `.api-entrypoints`.
const skippedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "_generated",
]);

function directoriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !skippedDirectories.has(entry.name),
    )
    .map((entry) => join(dir, entry.name));
}

// The functions directory of an app, or undefined if the directory is not an
// app. A workspace package that has no `package.json` is a leftover directory,
// not a package.
function functionsDirectory(packageDir: string): string | undefined {
  if (!existsSync(join(packageDir, "package.json"))) return undefined;
  let functions = "convex";
  const configPath = join(packageDir, "convex.json");
  if (existsSync(configPath)) {
    const config: { functions?: string } = JSON.parse(
      readFileSync(configPath, "utf8"),
    );
    functions = config.functions ?? functions;
  }
  const dir = join(packageDir, functions);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

function findComponentConfigs(dir: string, found: string[] = []): string[] {
  if (existsSync(join(dir, "convex.config.ts"))) found.push(dir);
  for (const child of directoriesIn(dir)) findComponentConfigs(child, found);
  return found;
}

const apps: { dir: string; functions: string }[] = [];
for (const workspaceRoot of workspaceRoots) {
  for (const packageDir of directoriesIn(join(root, workspaceRoot))) {
    if (packageDir === componentHost) continue;
    const functions = functionsDirectory(packageDir);
    if (functions !== undefined) apps.push({ dir: packageDir, functions });
  }
}
apps.sort((a, b) => a.dir.localeCompare(b.dir));

// Every `convex.config.ts` that is not the app-level config of an app defines a
// component.
const appFunctionDirs = new Set(apps.map((app) => app.functions));
const components = findComponentConfigs(root)
  .filter((dir) => !appFunctionDirs.has(dir))
  .sort((a, b) => a.localeCompare(b));

const args = process.argv.slice(2);
const list = args.includes("--list");
const filters = args.filter((arg) => !arg.startsWith("--"));
const selected = (path: string) =>
  filters.length === 0 ||
  filters.some((filter) => relative(root, path).includes(filter));

const selectedApps = apps.filter((app) => selected(app.dir));
const selectedComponents = components.filter(selected);

if (list) {
  console.log("Apps:");
  for (const app of selectedApps) console.log(`  ${relative(root, app.dir)}`);
  console.log("Components:");
  for (const dir of selectedComponents) console.log(`  ${relative(root, dir)}`);
  process.exit(0);
}

const tasks: CodegenTask[] = [
  ...selectedApps.map((app) => ({
    cwd: app.dir,
    title: relative(root, app.dir),
  })),
  // A component generates its code from the host directory, which is the app
  // that `--component-dir` is relative to.
  ...selectedComponents.map((dir) => ({
    cwd: componentHost,
    componentDir: relative(componentHost, dir),
    title: relative(root, dir),
  })),
];

if (tasks.length === 0) {
  console.log("Nothing matches the filters.");
  process.exit(0);
}

// The host runs `convex dev` with the CLI that it declares. Node runs the CLI
// directly, not through `pnpm exec`, thus a Ctrl-C in the terminal reaches the
// CLI once, from the terminal itself. A second SIGINT, half a second or more
// after the first, would make the CLI exit without stopping its backend.
function binOf(packageName: string, from: string, bin: string): string {
  const require = createRequire(join(from, "package.json"));
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson: { bin: string | Record<string, string> } = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  );
  const path =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin[bin];
  return join(dirname(packageJsonPath), path);
}
const convexBin = binOf("convex", componentHost, "convex");
const tsxBin = binOf("tsx", root, "tsx");

// `--start` runs its command through a shell.
const startCommand = [
  process.execPath,
  tsxBin,
  join(root, "scripts", "codegenTasks.ts"),
]
  .map((arg) => JSON.stringify(arg))
  .join(" ");

// These variables select a deployment, and the environment wins over
// `.env.local`. The host must use its own anonymous deployment whatever the
// shell of the developer selects.
//
// TODO: remove CODEGEN_SUCCESS_FILE once the Convex CLI passes on the exit code
// of the `--start` command. Until then, the CLI can exit with code 0 when the
// command fails, thus `scripts/codegenTasks.ts` creates this file on success. ETA
// convex === 1.50.0.
const successFile = join(
  mkdtempSync(join(tmpdir(), "convex-auth-codegen-")),
  "success",
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CODEGEN_TASKS: JSON.stringify(tasks),
  CODEGEN_SUCCESS_FILE: successFile,
};
for (const name of [
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
])
  delete env[name];

// `convex dev --once` starts the local backend of the host (and creates the
// anonymous deployment if it does not exist: its stdin is not a TTY, thus the
// CLI does not offer to log in), pushes the empty host app, and runs the
// `--start` command. Once that command exits, or on a SIGINT, the CLI stops the
// backend. The CLI owns the whole lifecycle, thus this script only waits.
const child = spawn(
  process.execPath,
  [
    convexBin,
    "dev",
    "--once",
    "--codegen",
    "disable",
    "--typecheck",
    "disable",
    "--tail-logs",
    "disable",
    "--start",
    startCommand,
  ],
  { cwd: componentHost, env, stdio: ["ignore", "inherit", "inherit"] },
);

// A Ctrl-C reaches the CLI from the terminal, thus this script waits for the
// CLI to clean up. Another signal reaches only this script, thus it passes it
// on as the SIGINT that makes the CLI stop its backend.
let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    interrupted = true;
    child.kill("SIGINT");
  });
}

const code = await new Promise<number>((resolve) =>
  child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0))),
);
const succeeded = existsSync(successFile);
rmSync(dirname(successFile), { recursive: true, force: true });
if (interrupted) process.exit(130);
// The CLI has already written each failure.
if (code !== 0) process.exit(code);
if (!succeeded) {
  console.error("\n✖ Codegen failed.");
  process.exit(1);
}

console.log("\n✔ Codegen complete.");
