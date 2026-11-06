// Runs `convex codegen` for each task that `scripts/codegen.ts` selected. Do not
// run this file yourself: `scripts/codegen.ts` runs it through `convex dev
// --once --start` in `scripts/codegen-host`, thus the deployment of the host is
// up while this file runs, and the CLI stops it once this file exits.
//
// The tasks come from the `CODEGEN_TASKS` environment variable, as JSON:
// `--start` runs its command through a shell, and an environment variable needs
// no quoting.
//
// The tasks run one after the other: two pushes to the same deployment race,
// and one of them fails with an OptimisticConcurrencyControlFailure. Each run
// takes about a second. An interactive terminal shows a live line per task; CI
// has no TTY, thus Listr writes a plain line for each event instead.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Listr } from "listr2";

export type CodegenTask = {
  // The directory that `convex codegen` runs in.
  cwd: string;
  // The component directory, relative to `cwd`, for a component.
  componentDir?: string;
  title: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const componentHost = join(root, "scripts", "codegen-host");

const tasks: CodegenTask[] = JSON.parse(process.env.CODEGEN_TASKS ?? "[]");

// `convex dev` saves the port and the admin key of an anonymous deployment
// here.
const configPath = join(
  componentHost,
  ".convex",
  "local",
  "default",
  "config.json",
);
const config: { ports?: { cloud?: unknown }; adminKey?: unknown } = JSON.parse(
  readFileSync(configPath, "utf8"),
);
if (
  typeof config.ports?.cloud !== "number" ||
  typeof config.adminKey !== "string"
) {
  console.error(
    `${relative(root, configPath)} has no port or no admin key. The Convex ` +
      `CLI may have changed where it saves an anonymous deployment.`,
  );
  process.exit(1);
}
const url = `http://127.0.0.1:${config.ports.cloud}`;
const adminKey = config.adminKey;

type Report = (line: string) => void;

// A terminal redraws one line per task, thus the live progress of a command is
// worth showing. CI has no TTY, where Listr writes each report as its own line:
// there, only the command itself is worth a line.
const interactive = process.stdout.isTTY === true;

class CommandFailed extends Error {
  constructor(label: string, output: string) {
    super(`${label} failed:\n\n${output.trim()}`);
    this.name = "CommandFailed";
  }
}

// Runs `convex codegen` against the deployment of the host. With `--url` and
// `--admin-key`, the CLI reads no environment variable and no `.env.local`.
// The whole output is kept, because a failure has to show it: only the last
// line is visible while the command runs.
async function codegen(task: CodegenTask, report: Report): Promise<void> {
  const args = ["codegen", "--typecheck", "disable"];
  if (task.componentDir !== undefined)
    args.push("--component-dir", task.componentDir);
  // The task title already names the directory in a terminal. The verbose
  // renderer writes one line per event, thus there the line has to name it
  // itself. Neither shows the admin key.
  const label = interactive
    ? `convex ${args.join(" ")}`
    : `${relative(root, task.cwd)}$ convex ${args.join(" ")}`;
  report(label);
  const child = spawn(
    "pnpm",
    ["exec", "convex", ...args, "--url", url, "--admin-key", adminKey],
    { cwd: task.cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (!interactive) return;
    const lastLine = text.trimEnd().split("\n").at(-1)?.trim();
    if (lastLine) report(`${label} — ${lastLine}`);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  if (code !== 0)
    throw new CommandFailed(`${task.title}: convex codegen`, output);
}

const listr = new Listr(
  tasks.map((t) => ({
    title: t.title,
    task: (_context: unknown, task: { output: string }) =>
      codegen(t, (line) => {
        task.output = line;
      }),
  })),
  {
    concurrent: false,
    exitOnError: false,
    collectErrors: true,
    // A terminal shows a live line per task. CI has no TTY, thus Listr falls
    // back to the verbose renderer, which writes each event as a plain line.
    renderer: "default",
    fallbackRenderer: "verbose",
    // On a Ctrl-C, the CLI passes a SIGINT to this process. Listr would exit
    // with code 127, which the CLI reports as a failed command; without a
    // listener, the signal ends this process, which the CLI takes as a stop.
    registerSignalListeners: false,
  },
);
await listr.run();

// Listr has already written each failure, thus the exit code is all that is
// left to report.
process.exit((listr.errors ?? []).length > 0 ? 1 : 0);
