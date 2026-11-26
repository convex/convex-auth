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
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  keyMismatchWarning,
  parseEnvFile,
  resolveTarget,
  TargetError,
  type ResolvedTarget,
} from "./config.ts";
import { TIMELINE_VERSION, type TimelineEvent } from "./events.ts";
import { LogPoller, type LogPage } from "./logPoller.ts";
import { eventsFromLogEntry, isLogEntry } from "./logs.ts";
import type { ProjectConfig } from "./project.ts";
import { PROJECTS } from "./projects/index.ts";
import { SyncReader } from "./sync.ts";
import { TimelineBuilder } from "./timeline.ts";

const USAGE = `Usage: pnpm --filter @convex-dev/explorer record <app directory> [options]

Records the function logs and the data changes of the deployment of a Convex
app into a timeline (NDJSON), until Ctrl-C. Reads a local deployment unless
--cloud is given.

Options:
  --cloud                Record a cloud deployment, with CONVEX_DEPLOY_KEY
  --out <file>           Where to write the timeline (default: timeline-<time>.ndjson)
  --url <url>            The deployment URL (default: from the app's .env.local)
  --project <name>       What to keep of the app's tables: ${Object.keys(PROJECTS).join(", ")} (default: generic)
  --drop-personal-data   Replace the personal data that the project keeps
  --history <n>          Also record the last n function runs before the start
  --poll <ms>            How often to poll the data sync once it caught up (default: 1000)
  --settle <ms>          How long to wait for the other feed before writing (default: 3000)

Local: the admin key of the deployment that \`npx convex dev\` runs, or
CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY.
Cloud: CONVEX_DEPLOY_KEY, a deploy key of the deployment.`;

class UsageError extends Error {}

/** A failure that retrying does not fix. */
class FatalError extends Error {}

type Options = ResolvedTarget & {
  out: string;
  project: ProjectConfig;
  history: number;
  pollMs: number;
  settleMs: number;
};

function readOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cloud: { type: "boolean" },
      out: { type: "string" },
      url: { type: "string" },
      project: { type: "string" },
      "drop-personal-data": { type: "boolean" },
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
  const base = process.env.INIT_CWD ?? process.cwd();
  const appDir = resolve(base, positionals[0]);
  if (!existsSync(join(appDir, "convex"))) {
    throw new UsageError(`${appDir} has no convex/ directory.`);
  }
  const projectName = values.project ?? "generic";
  const baseProject = PROJECTS[projectName];
  if (baseProject === undefined) {
    throw new UsageError(
      `Unknown project "${projectName}". Known: ${Object.keys(PROJECTS).join(", ")}.`,
    );
  }
  const project =
    values["drop-personal-data"] === true
      ? { ...baseProject, keepPersonalData: false }
      : baseProject;
  const target = resolveTarget({
    target: values.cloud === true ? "cloud" : "local",
    appVariables: {
      ...readEnvFile(join(appDir, ".env")),
      ...readEnvFile(join(appDir, ".env.local")),
    },
    env: process.env,
    url: values.url,
    localAdminKey: readLocalAdminKey(appDir),
  });
  if (target.target === "cloud") {
    const mismatch = keyMismatchWarning(target.key, target.url);
    if (mismatch !== null) {
      console.error(`Warning: ${mismatch}`);
    }
  }
  return {
    ...target,
    out: resolve(
      base,
      values.out ??
        `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`,
    ),
    project,
    history: number("--history", values.history, 0),
    pollMs: number("--poll", values.poll, 1000),
    settleMs: number("--settle", values.settle, 3000),
  };
}

function number(flag: string, value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} takes a whole number, not "${value}".`);
  }
  return parsed;
}

function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

function readLocalAdminKey(appDir: string): string | null {
  const path = join(appDir, ".convex", "local", "default", "config.json");
  if (!existsSync(path)) {
    return null;
  }
  const { adminKey } = JSON.parse(readFileSync(path, "utf8")) as {
    adminKey?: unknown;
  };
  return typeof adminKey === "string" ? adminKey : null;
}

/**
 * Fetches from the deployment with the key. Never shows the key in an error.
 */
async function deploymentFetch(
  options: Options,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  stop: AbortSignal,
): Promise<string> {
  const response = await fetch(`${options.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Convex ${options.key}`,
      "Content-Type": "application/json",
      // The log stream gives each log line as an object, with the component
      // that wrote it, only to clients of this version or later.
      "Convex-Client": "npm-cli-1.48.0",
    },
    signal: AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new FatalError(
      `The deployment rejected the key (HTTP ${response.status}). Check that the key is for ${options.url}.`,
    );
  }
  if (response.status === 404) {
    throw new FatalError(
      `${options.url} has no ${path.split("?")[0]} (HTTP 404). Check the URL; on cloud, the data sync API needs a Pro plan.`,
    );
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Runs `step` until `stopped`, retrying a failure with backoff. A
 * {@link FatalError} ends the loop and the recording.
 */
async function loop(
  name: string,
  stopped: () => boolean,
  step: () => Promise<void>,
): Promise<void> {
  let failures = 0;
  while (!stopped()) {
    try {
      await step();
      failures = 0;
    } catch (error) {
      if (error instanceof FatalError || stopped()) {
        throw error;
      }
      failures++;
      const wait = Math.min(30_000, 500 * 2 ** failures);
      console.error(
        `Reading ${name} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait} ms.`,
      );
      await sleep(wait);
    }
  }
}

async function record(options: Options): Promise<void> {
  const builder = new TimelineBuilder(options.settleMs);
  const startedAt = Date.now();
  const stop = new AbortController();
  const stopped = () => stop.signal.aborted;
  const header: TimelineEvent = {
    kind: "recording",
    v: TIMELINE_VERSION,
    time: startedAt,
    deploymentUrl: options.url,
    project: options.project.name,
  };
  writeFileSync(options.out, JSON.stringify(header) + "\n");
  const counts = { run: 0, step: 0, log: 0, write: 0 };

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

  // The log stream.
  const poller = new LogPoller(
    async (cursor): Promise<LogPage> =>
      JSON.parse(
        await deploymentFetch(
          options,
          `/api/stream_function_logs?cursor=${cursor}`,
          { method: "GET" },
          // The deployment holds a request open while it has no new entry.
          120_000,
          stop.signal,
        ),
      ) as LogPage,
    startedAt,
    options.history,
  );
  // Lines seen per execution, to number the lines of an action across its
  // `Progress` and `Completion` entries.
  const linesSeen = new Map<string, number>();
  const logs = loop("the function logs", stopped, async () => {
    for (const entry of await poller.next()) {
      if (!isLogEntry(entry)) {
        continue;
      }
      const seen = linesSeen.get(entry.executionId) ?? 0;
      const { run, lines } = eventsFromLogEntry(entry, seen);
      linesSeen.set(entry.executionId, seen + lines.length);
      builder.add(run === null ? lines : [run, ...lines], Date.now());
    }
  });

  // The data sync.
  const reader = new SyncReader(options.project);
  let snapshotDone = false;
  let snapshotCount = 0;
  console.error(`Reading the data of ${options.url}...`);
  const sync = loop("the data sync", stopped, async () => {
    const text = await deploymentFetch(
      options,
      "/api/v1/data/sync",
      {
        method: "POST",
        body: JSON.stringify(
          reader.cursor === null ? {} : { cursor: reader.cursor },
        ),
      },
      30_000,
      stop.signal,
    );
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
  });

  const flushing = setInterval(() => flush(Date.now()), 250);
  let finishing: Promise<void> | null = null;
  const finish = (code: number, message?: string) => {
    finishing ??= (async () => {
      if (message !== undefined) {
        console.error(message);
      }
      stop.abort();
      clearInterval(flushing);
      // Requests in flight end with the abort; do not wait long for them.
      await Promise.race([Promise.allSettled([logs, sync]), sleep(2000)]);
      flush(Infinity);
      console.error(
        `Wrote ${counts.run} runs, ${counts.step} steps, ${counts.log} log lines, and ${counts.write} writes to ${options.out}`,
      );
      process.exit(code);
    })();
    return finishing;
  };
  process.once("SIGINT", () => void finish(0));
  process.once("SIGTERM", () => void finish(0));
  for (const reading of [logs, sync]) {
    reading.catch((error: unknown) => {
      if (!stopped()) {
        void finish(1, error instanceof Error ? error.message : String(error));
      }
    });
  }
}

try {
  await record(readOptions(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError || error instanceof TargetError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  throw error;
}
