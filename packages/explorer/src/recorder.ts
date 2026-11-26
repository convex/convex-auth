/**
 * Records a timeline from a running deployment, and optionally from a
 * browser that drives the app's page. The CLI (`cli.ts`) and the checks in
 * `scripts/` call {@link record}.
 *
 * Node-only.
 *
 * @module
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { BrowserRedactor } from "./browser.ts";
import { BrowserSession } from "./browserRecorder.ts";
import type { ResolvedTarget } from "./config.ts";
import { TIMELINE_VERSION, type TimelineEvent } from "./events.ts";
import { LogPoller, type TimedLogPage } from "./logPoller.ts";
import { eventsFromLogEntry, isLogEntry } from "./logs.ts";
import { nodeDigest } from "./nodeDigest.ts";
import { browserConfig, type ProjectConfig } from "./project.ts";
import { runScenario, type Scenario } from "./scenario.ts";
import { Secrets } from "./secrets.ts";
import { SyncReader } from "./sync.ts";
import { TimelineBuilder } from "./timeline.ts";

/** A failure that retrying does not fix. */
export class FatalError extends Error {}

export type BrowserRecording = {
  /** The app's page to open. */
  url: string;
  /** The scenario to run on it; without one, a person drives the page. */
  scenario: Scenario | null;
  /** Show the window. */
  headed: boolean;
  /** The Chromium to run; see `BrowserOptions.executablePath`. */
  executablePath?: string;
};

export type RecordOptions = ResolvedTarget & {
  out: string;
  project: ProjectConfig;
  history: number;
  pollMs: number;
  settleMs: number;
  /** Also record a browser on the app's page. */
  browser: BrowserRecording | null;
};

export type RecordHooks = {
  /** Aborting it stops the recording. */
  stop?: AbortSignal;
  /** Progress messages. Default: stderr. */
  log?: (message: string) => void;
  /**
   * Gets each raw secret that the recorder saw (tokens of the browser,
   * digests of the data feed, secrets that the scenario typed), for a check
   * that looks for them in the timeline. Never written.
   */
  onRawSecret?: (value: string) => void;
};

/** The number of events written, by kind. */
export type RecordResult = {
  counts: Record<string, number>;
  /** 0 on success, 1 when a feed failed or the scenario threw. */
  code: number;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Fetches from the deployment with the key. Never shows the key in an error.
 */
async function deploymentFetch(
  options: RecordOptions,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  stop: AbortSignal,
): Promise<{ text: string; date: number | null; receivedAt: number }> {
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
  const receivedAt = Date.now();
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
  const header = response.headers.get("date");
  const date = header === null ? NaN : Date.parse(header);
  return { text, date: Number.isNaN(date) ? null : date, receivedAt };
}

/**
 * Runs `step` until `stopped`, retrying a failure with backoff. A
 * {@link FatalError} ends the loop and the recording.
 */
async function loop(
  name: string,
  stopped: () => boolean,
  log: (message: string) => void,
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
      log(
        `Reading ${name} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${wait} ms.`,
      );
      await sleep(wait);
    }
  }
}

/**
 * Records until the scenario ends, the person closes the browser, `stop`
 * aborts, or a feed fails for good.
 */
export async function record(
  options: RecordOptions,
  hooks: RecordHooks = {},
): Promise<RecordResult> {
  const log = hooks.log ?? ((message: string) => console.error(message));
  const builder = new TimelineBuilder(options.settleMs);
  const startedAt = Date.now();
  const stop = new AbortController();
  hooks.stop?.addEventListener("abort", () => stop.abort(), { once: true });
  const stopped = () => stop.signal.aborted;
  const header: TimelineEvent = {
    kind: "recording",
    v: TIMELINE_VERSION,
    time: startedAt,
    deploymentUrl: options.url,
    project: options.project.name,
    ...(options.browser === null
      ? {}
      : {
          page: options.browser.url,
          ...(options.browser.scenario === null
            ? {}
            : { scenario: options.browser.scenario.name }),
        }),
  };
  writeFileSync(options.out, JSON.stringify(header) + "\n");
  const counts: Record<string, number> = {};

  const secrets = new Secrets(
    browserConfig(options.project),
    nodeDigest,
    hooks.onRawSecret,
  );
  const add = (events: readonly TimelineEvent[]) => {
    const now = Date.now();
    builder.add(events, now);
    builder.add(secrets.drain(), now);
  };
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
      counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    }
  };

  // The log stream.
  const poller = new LogPoller(
    async (cursor): Promise<TimedLogPage> => {
      const { text, date, receivedAt } = await deploymentFetch(
        options,
        `/api/stream_function_logs?cursor=${cursor}`,
        { method: "GET" },
        // The deployment holds a request open while it has no new entry.
        120_000,
        stop.signal,
      );
      return { ...(JSON.parse(text) as TimedLogPage), date, receivedAt };
    },
    startedAt,
    options.history,
  );
  // Lines seen per execution, to number the lines of an action across its
  // `Progress` and `Completion` entries.
  const linesSeen = new Map<string, number>();
  const logs = loop("the function logs", stopped, log, async () => {
    for (const entry of await poller.next()) {
      if (!isLogEntry(entry)) {
        continue;
      }
      const seen = linesSeen.get(entry.executionId) ?? 0;
      const { run, lines } = eventsFromLogEntry(entry, seen);
      linesSeen.set(entry.executionId, seen + lines.length);
      add(run === null ? lines : [run, ...lines]);
    }
  });

  // The data sync.
  const reader = new SyncReader(options.project, (...document) =>
    secrets.observeDocument(...document),
  );
  let snapshotCount = 0;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((done) => (markReady = done));
  let snapshotDone = false;
  log(`Reading the data of ${options.url}...`);
  const sync = loop("the data sync", stopped, log, async () => {
    const { text } = await deploymentFetch(
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
      log(
        "The data sync started over (a new snapshot): the timeline holds the new snapshot as writes.",
      );
    }
    add(writes);
    if (!snapshotDone) {
      snapshotCount += writes.filter((write) => write.snapshot).length;
    }
    if (reader.upToDate) {
      if (!snapshotDone) {
        snapshotDone = true;
        markReady();
      }
      await sleep(options.pollMs);
    }
  });

  const flushing = setInterval(() => flush(Date.now()), 250);
  let failure: string | null = null;
  const failed = new Promise<void>((done) => {
    for (const reading of [logs, sync]) {
      reading.catch((error: unknown) => {
        if (!stopped()) {
          failure = error instanceof Error ? error.message : String(error);
          done();
        }
      });
    }
  });
  const aborted = new Promise<void>((done) =>
    stop.signal.addEventListener("abort", () => done(), { once: true }),
  );

  let session: BrowserSession | null = null;
  let scenarioFailed = false;
  await Promise.race([ready, failed, aborted]);
  if (failure === null && !stopped()) {
    log(`Snapshot: ${snapshotCount} documents.`);
    if (options.browser === null) {
      log("Recording; press Ctrl-C to stop.");
      await Promise.race([failed, aborted]);
    } else {
      const browser = options.browser;
      const redactor = new BrowserRedactor(options.project, secrets);
      session = await BrowserSession.start({
        url: browser.url,
        headed: browser.headed,
        executablePath: browser.executablePath,
        deploymentUrl: options.url,
        redactor,
        secrets,
        emit: (events) => {
          add(events);
          builder.skew = session?.skew ?? 0;
        },
      });
      if (browser.scenario === null) {
        log(
          `Recording ${browser.url}; use the page, then close the browser or press Ctrl-C.`,
        );
        await Promise.race([session.closed, failed, aborted]);
      } else {
        log(
          `Running the scenario ${browser.scenario.name} on ${browser.url}...`,
        );
        const scenario = runScenario(
          browser.scenario,
          session.page,
          browser.url,
          (event) => add([event]),
          hooks.onRawSecret,
        ).then(
          () => log("The scenario ended."),
          (error: unknown) => {
            scenarioFailed = true;
            log(
              `The scenario failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        );
        await Promise.race([scenario, failed, aborted]);
        // The logs of the last runs reach the recorder after the page saw
        // their results.
        if (!stopped() && failure === null) {
          await Promise.race([sleep(3000), failed, aborted]);
        }
      }
    }
  }

  if (failure !== null) {
    log(failure);
  }
  await session?.close();
  add([]);
  stop.abort();
  clearInterval(flushing);
  // Requests in flight end with the abort; do not wait long for them.
  await Promise.race([Promise.allSettled([logs, sync]), sleep(2000)]);
  builder.skew = session?.skew ?? builder.skew;
  flush(Infinity);
  const summary = Object.entries(counts)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  log(`Wrote ${summary || "nothing"} to ${options.out}`);
  return { counts, code: failure !== null || scenarioFailed ? 1 : 0 };
}
