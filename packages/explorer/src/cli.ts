/**
 * Records a timeline from a running deployment.
 *
 * ```sh
 * pnpm --filter @convex-dev/explorer record <app directory> [--out <file>]
 * ```
 *
 * See the README for the options.
 *
 * @module
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  deploymentUrlOf,
  isLocalDeployment,
  keyMismatchWarning,
  parseEnvFile,
} from "./config.ts";
import { TIMELINE_VERSION, type TimelineEvent } from "./events.ts";
import { eventsFromLogEntry, isLogEntry } from "./logs.ts";
import { SyncReader } from "./sync.ts";
import { TimelineBuilder } from "./timeline.ts";

const USAGE = `Usage: pnpm --filter @convex-dev/explorer record <app directory> [options]

Records the function logs and the data changes of the deployment of an app
into a timeline (NDJSON), until Ctrl-C.

Options:
  --out <file>      Where to write the timeline (default: timeline-<time>.ndjson)
  --url <url>       The deployment URL (default: from the app's .env.local)
  --history <n>     Also record the last n function runs before the start
  --poll <ms>       How often to poll the data sync once it caught up (default: 1000)
  --settle <ms>     How long to wait for the other feed before writing (default: 3000)

The key for the data sync: CONVEX_DEPLOY_KEY, a deploy key of the deployment.
For a local deployment, the admin key in <app>/.convex/local/default/config.json.`;

class UsageError extends Error {}

type Options = {
  appDir: string;
  out: string;
  url: string;
  key: string;
  localDeployment: boolean;
  history: number | null;
  pollMs: number;
  settleMs: number;
};

function readOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      url: { type: "string" },
      history: { type: "string" },
      poll: { type: "string" },
      settle: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length !== 1) {
    throw new UsageError("Give one app directory.");
  }
  // `pnpm --filter` runs the script in this package, thus a relative path is
  // relative to where the user ran pnpm.
  const appDir = resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]);
  if (!existsSync(join(appDir, "convex"))) {
    throw new UsageError(`${appDir} has no convex/ directory.`);
  }
  const variables = {
    ...readEnvFile(join(appDir, ".env")),
    ...readEnvFile(join(appDir, ".env.local")),
  };
  const url = values.url ?? deploymentUrlOf(variables);
  if (url === null) {
    throw new UsageError(
      `Found no deployment URL in ${join(appDir, ".env.local")}. Run \`npx convex dev\` in the app once, or pass --url.`,
    );
  }
  const localDeployment = isLocalDeployment(variables.CONVEX_DEPLOYMENT);
  const key =
    process.env.CONVEX_DEPLOY_KEY ?? localAdminKey(appDir, localDeployment);
  const mismatch = keyMismatchWarning(key, url);
  if (mismatch !== null) {
    console.error(`Warning: ${mismatch}`);
  }
  const out = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    values.out ??
      `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`,
  );
  return {
    appDir,
    out,
    url,
    key,
    localDeployment,
    history:
      values.history === undefined ? null : number("--history", values.history),
    pollMs: values.poll === undefined ? 1000 : number("--poll", values.poll),
    settleMs:
      values.settle === undefined ? 3000 : number("--settle", values.settle),
  };
}

function number(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} takes a whole number, not "${value}".`);
  }
  return parsed;
}

function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

function localAdminKey(appDir: string, localDeployment: boolean): string {
  const path = join(appDir, ".convex", "local", "default", "config.json");
  if (!localDeployment || !existsSync(path)) {
    throw new UsageError(
      "Set CONVEX_DEPLOY_KEY to a deploy key of the deployment (dashboard: Settings, then Deploy Keys). On cloud, the data sync API needs a Pro plan.",
    );
  }
  const { adminKey } = JSON.parse(readFileSync(path, "utf8")) as {
    adminKey?: unknown;
  };
  if (typeof adminKey !== "string") {
    throw new UsageError(`${path} has no adminKey.`);
  }
  return adminKey;
}

/** Fetches one page of the data sync. Never shows the key in an error. */
async function fetchSyncPage(
  options: Options,
  cursor: string | null,
): Promise<string> {
  const response = await fetch(`${options.url}/api/v1/data/sync`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${options.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cursor === null ? {} : { cursor }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new FatalError(
      `The deployment rejected the key (HTTP ${response.status}). Check that CONVEX_DEPLOY_KEY is a deploy key of ${options.url}.`,
    );
  }
  if (response.status === 404) {
    throw new FatalError(
      `${options.url} has no data sync API (HTTP 404). Check the URL; on cloud, the API needs a Pro plan.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `The data sync answered HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  return text;
}

class FatalError extends Error {}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function record(options: Options): Promise<void> {
  const builder = new TimelineBuilder(options.settleMs);
  const startedAt = Date.now();
  const header: TimelineEvent = {
    kind: "recording",
    v: TIMELINE_VERSION,
    time: startedAt,
    deploymentUrl: options.url,
  };
  writeFileSync(options.out, JSON.stringify(header) + "\n");
  const counts = { run: 0, step: 0, log: 0, write: 0 };
  let stopping = false;

  const flush = (now: number) => {
    const events = builder.drain(now);
    if (events.length === 0) {
      return;
    }
    appendFileSync(
      options.out,
      events.map((event) => JSON.stringify(event) + "\n").join(""),
    );
    for (const event of events) {
      if (event.kind !== "recording") {
        counts[event.kind]++;
      }
    }
  };

  const logs = tailLogs(options, builder, () => {
    if (!stopping) {
      fail("`npx convex logs` stopped.");
    }
  });
  // A detached child outlives the recorder unless it is stopped.
  process.once("exit", () => stopLogs(logs));

  let fatal: unknown = null;
  const syncing = syncLoop(options, builder, () => stopping).catch((error) => {
    fatal = error;
    stopping = true;
  });
  const flushing = setInterval(() => flush(Date.now()), 250);

  const stop = async (code: number) => {
    stopping = true;
    clearInterval(flushing);
    stopLogs(logs);
    // A poll in flight can take a while; do not wait for it for long.
    await Promise.race([syncing, sleep(2000)]);
    flush(Infinity);
    console.error(
      `Wrote ${counts.run} runs, ${counts.step} steps, ${counts.log} log lines, and ${counts.write} writes to ${options.out}`,
    );
    process.exit(code);
  };
  const fail = (message: string) => {
    console.error(message);
    void stop(1);
  };
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));

  await syncing;
  if (fatal !== null) {
    fail(fatal instanceof Error ? fatal.message : String(fatal));
  }
}

function tailLogs(
  options: Options,
  builder: TimelineBuilder,
  onExit: () => void,
): ChildProcess {
  const args = ["convex", "logs", "--jsonl", "--success"];
  if (options.history !== null) {
    args.push("--history", String(options.history));
  }
  const env = { ...process.env };
  if (options.localDeployment && env.CONVEX_AGENT_MODE === undefined) {
    env.CONVEX_AGENT_MODE = "anonymous";
  }
  const child = spawn("npx", args, {
    cwd: options.appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so that `stopLogs` ends `npx` and the CLI that
    // it starts together.
    detached: true,
  });
  // Lines seen per execution, to number the lines of an action across its
  // `Progress` and `Completion` entries.
  const linesSeen = new Map<string, number>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      console.error(`Skipped a line of \`npx convex logs\` that is not JSON.`);
      return;
    }
    if (!isLogEntry(entry)) {
      return;
    }
    const seen = linesSeen.get(entry.executionId) ?? 0;
    const { run, lines } = eventsFromLogEntry(entry, seen);
    linesSeen.set(entry.executionId, seen + lines.length);
    builder.add(run === null ? lines : [run, ...lines], Date.now());
  });
  createInterface({ input: child.stderr! }).on("line", (line) => {
    console.error(`[convex logs] ${line}`);
  });
  child.on("exit", onExit);
  return child;
}

function stopLogs(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

async function syncLoop(
  options: Options,
  builder: TimelineBuilder,
  stopping: () => boolean,
): Promise<void> {
  const reader = new SyncReader();
  let snapshotDone = false;
  let snapshotCount = 0;
  let failures = 0;
  console.error(`Reading the data of ${options.url}...`);
  while (!stopping()) {
    let text: string;
    try {
      text = await fetchSyncPage(options, reader.cursor);
      failures = 0;
    } catch (error) {
      if (error instanceof FatalError) {
        throw error;
      }
      failures++;
      const wait = Math.min(30_000, 500 * 2 ** failures);
      console.error(
        `The data sync failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait} ms.`,
      );
      await sleep(wait);
      continue;
    }
    const { writes, reset } = reader.read(text);
    if (reset) {
      console.error(
        "The data sync started over (a new snapshot): the timeline holds the new snapshot as writes.",
      );
    }
    builder.add(writes, Date.now());
    if (!snapshotDone) {
      snapshotCount += writes.filter((write) => write.snapshot).length;
    }
    if (reader.upToDate) {
      if (!snapshotDone) {
        snapshotDone = true;
        console.error(
          `Snapshot: ${snapshotCount} documents. Recording; press Ctrl-C to stop.`,
        );
      }
      await sleep(options.pollMs);
    }
  }
}

try {
  await record(readOptions(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  throw error;
}
