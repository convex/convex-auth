/**
 * Merges the events of both feeds into one ordered timeline, and attaches each
 * write to the function run that made it.
 *
 * @module
 */
import { linkCall, type LinkContext } from "./calls.ts";
import type {
  CallEvent,
  RunEvent,
  TimelineEvent,
  WriteEvent,
} from "./events.ts";

/**
 * How far, in ms, a commit time may fall outside the window of a run and
 * still match it. The logs give the start of a run to the millisecond.
 */
export const COMMIT_TOLERANCE_MS = 1;

/**
 * The run whose transaction committed at `time`, or null.
 *
 * All the writes of one transaction share one commit time, and it falls in
 * the window `[time, endTime]` of the run that made them. Only a mutation
 * that succeeded commits. When the windows of several runs hold the time, the
 * run that finished closest after it wins, and among those, the one whose
 * write count equals `writeCount`.
 */
export function runForCommit(
  runs: readonly RunEvent[],
  time: number,
  writeCount: number,
): RunEvent | null {
  let best: RunEvent | null = null;
  let bestScore = Infinity;
  for (const run of runs) {
    if (run.udfType !== "Mutation" || !run.ok) {
      continue;
    }
    if (
      time < run.time - COMMIT_TOLERANCE_MS ||
      time > run.endTime + COMMIT_TOLERANCE_MS
    ) {
      continue;
    }
    const score =
      Math.abs(run.endTime - time) + (run.writeCount === writeCount ? 0 : 1e6);
    if (score < bestScore) {
      best = run;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Copies of the writes with `runId` set by {@link runForCommit}. A write that
 * matches no run keeps `runId: null`.
 */
export function attachWrites(
  writes: readonly WriteEvent[],
  runs: readonly RunEvent[],
): WriteEvent[] {
  const counts = new Map<string, number>();
  for (const write of writes) {
    counts.set(write.ts, (counts.get(write.ts) ?? 0) + 1);
  }
  const byTs = new Map<string, string | null>();
  return writes.map((write) => {
    if (!byTs.has(write.ts)) {
      byTs.set(
        write.ts,
        runForCommit(runs, write.time, counts.get(write.ts) ?? 0)?.id ?? null,
      );
    }
    return { ...write, runId: byTs.get(write.ts) ?? null };
  });
}

// At one time, a run comes before its lines, and the lines before the
// writes, which commit at the end of the run. The events of the browser come
// before the runs they cause, and a secret before the links that name it.
const KIND_ORDER: Record<TimelineEvent["kind"], number> = {
  recording: 0,
  scenario: 1,
  page: 1,
  input: 1,
  http: 1,
  socket: 1,
  storage: 1,
  cookie: 1,
  console: 1,
  call: 1,
  secret: 2,
  run: 3,
  step: 4,
  log: 4,
  write: 5,
  secretLink: 6,
};

/** Copies of the calls linked to the runs, each run to one call at most. */
export function linkCalls(
  calls: readonly CallEvent[],
  context: Omit<LinkContext, "used"> & { used: Set<string> },
): CallEvent[] {
  return calls.map((call) => {
    const linked = linkCall(call, context);
    if (linked.runId !== null) {
      context.used.add(linked.runId);
    }
    return linked;
  });
}

function countLines(
  events: readonly TimelineEvent[],
  counts: Map<string, number>,
) {
  for (const event of events) {
    if (event.kind === "log" || event.kind === "step") {
      counts.set(event.runId, (counts.get(event.runId) ?? 0) + 1);
    }
  }
}

/** Events sorted by time, stable for events of the same time and kind. */
export function sortEvents<Event extends TimelineEvent>(
  events: readonly Event[],
): Event[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.time - b.event.time ||
        KIND_ORDER[a.event.kind] - KIND_ORDER[b.event.kind] ||
        a.index - b.index,
    )
    .map(({ event }) => event);
}

function eventKey(event: TimelineEvent): string {
  return event.kind === "recording" ? "recording" : `${event.kind}:${event.id}`;
}

/**
 * One timeline from the events of the feeds: duplicates (same kind and id)
 * dropped, writes attached to runs, calls linked to runs, everything sorted
 * by time. `skew` is the offset of the deployment's clock from the
 * recorder's, in ms.
 */
export function mergeTimeline(
  events: readonly TimelineEvent[],
  skew = 0,
): TimelineEvent[] {
  const seen = new Set<string>();
  const unique: TimelineEvent[] = [];
  for (const event of events) {
    const key = eventKey(event);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(event);
    }
  }
  const runs = unique.filter((event) => event.kind === "run");
  const writes = attachWrites(
    unique.filter((event) => event.kind === "write"),
    runs,
  );
  const lineCounts = new Map<string, number>();
  countLines(unique, lineCounts);
  const calls = linkCalls(
    unique.filter((event) => event.kind === "call"),
    { runs, lineCounts, used: new Set(), skew },
  );
  let nextWrite = 0;
  let nextCall = 0;
  return sortEvents(
    unique.map((event) =>
      event.kind === "write"
        ? writes[nextWrite++]
        : event.kind === "call"
          ? calls[nextCall++]
          : event,
    ),
  );
}

/**
 * How long after an event arrives, in ms, the log stream must be known to be
 * read before a write or a call that waits on it is released. The deployment
 * writes the log entry of a run as the run ends, a few ms either side of the
 * moment its result or its commit leaves it.
 */
export const LOG_MARGIN_MS = 25;

export type TimelineBuilderOptions = {
  /**
   * Release each event as soon as nothing it depends on can still arrive,
   * instead of always after `settleMs`. A write of a transaction and a call
   * of the page wait until the log stream is known to be read past their
   * arrival (see {@link TimelineBuilder.logsReadUntil}), since the run they
   * attach to comes from it; every other event is released at once.
   * `settleMs` stays the longest any event is held.
   */
  early?: boolean;
};

/**
 * Builds a timeline while the feeds arrive, for a recorder that writes events
 * as it goes.
 *
 * The two feeds are not in step: a write can arrive before the log entry of
 * its run, or after. Thus the builder holds a write, and a call of the page,
 * until its run can have arrived, then releases it with the runs known by
 * then. Without `early`, it holds every event for `settleMs` after it
 * arrives. With `early`, it releases a write or a call once the log stream
 * is read past its arrival, and every other event at once; `settleMs` bounds
 * the wait. A write or a call whose run arrives later than that stays
 * unattached.
 *
 * The events of one call of {@link drain} are in order; with `early`, an
 * event that waited can come after a later event released before it.
 */
export class TimelineBuilder {
  private pending: { event: TimelineEvent; arrival: number }[] = [];
  private runs: RunEvent[] = [];
  private seen = new Set<string>();
  private lineCounts = new Map<string, number>();
  private usedRuns = new Set<string>();
  private logsUntil = -Infinity;
  private readonly early: boolean;

  /**
   * The offset of the deployment's clock from the recorder's, in ms, for
   * linking calls. Set it as the browser feed learns it.
   */
  skew = 0;

  constructor(
    private readonly settleMs: number,
    options: TimelineBuilderOptions = {},
  ) {
    this.early = options.early ?? false;
  }

  /** Adds events that arrived at `now` (ms, of the recorder's clock). */
  add(events: readonly TimelineEvent[], now: number): void {
    for (const event of events) {
      const key = eventKey(event);
      if (this.seen.has(key)) {
        continue;
      }
      this.seen.add(key);
      if (event.kind === "run") {
        this.runs.push(event);
      }
      countLines([event], this.lineCounts);
      this.pending.push({ event, arrival: now });
    }
  }

  /**
   * Tells the builder that every entry the log stream held at `time` (ms, of
   * the recorder's clock) has been added.
   */
  logsReadUntil(time: number): void {
    this.logsUntil = Math.max(this.logsUntil, time);
  }

  /**
   * The time (ms, of the recorder's clock) the log stream must be read until
   * to release the next event that waits on it, or null when none waits.
   */
  waitingForLogs(): number | null {
    let earliest: number | null = null;
    for (const item of this.pending) {
      if (waitsForLogs(item.event)) {
        const until = item.arrival + LOG_MARGIN_MS;
        if (until > this.logsUntil && (earliest === null || until < earliest)) {
          earliest = until;
        }
      }
    }
    return earliest;
  }

  private ready(item: { event: TimelineEvent; arrival: number }, now: number) {
    if (item.arrival + this.settleMs <= now) {
      return true;
    }
    if (!this.early) {
      return false;
    }
    return (
      !waitsForLogs(item.event) ||
      item.arrival + LOG_MARGIN_MS <= this.logsUntil
    );
  }

  /**
   * The events that are ready by `now`, in order. Pass `Infinity` to release
   * everything.
   */
  drain(now: number): TimelineEvent[] {
    const readyEvents: TimelineEvent[] = [];
    const rest: typeof this.pending = [];
    for (const item of this.pending) {
      if (this.ready(item, now)) {
        readyEvents.push(item.event);
      } else {
        rest.push(item);
      }
    }
    this.pending = rest;
    const writes = attachWrites(
      readyEvents.filter((event) => event.kind === "write"),
      this.runs,
    );
    const calls = linkCalls(
      readyEvents.filter((event) => event.kind === "call"),
      {
        runs: this.runs,
        lineCounts: this.lineCounts,
        used: this.usedRuns,
        skew: this.skew,
      },
    );
    let nextWrite = 0;
    let nextCall = 0;
    return sortEvents(
      readyEvents.map((event) =>
        event.kind === "write"
          ? writes[nextWrite++]
          : event.kind === "call"
            ? calls[nextCall++]
            : event,
      ),
    );
  }
}

/** A write of a transaction, or a call of the page: it attaches to a run. */
function waitsForLogs(event: TimelineEvent): boolean {
  return (event.kind === "write" && !event.snapshot) || event.kind === "call";
}
