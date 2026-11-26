/**
 * Merges the events of both feeds into one ordered timeline, and attaches each
 * write to the function run that made it.
 *
 * @module
 */
import type { RunEvent, TimelineEvent, WriteEvent } from "./events.ts";

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
// writes, which commit at the end of the run.
const KIND_ORDER: Record<TimelineEvent["kind"], number> = {
  recording: 0,
  run: 1,
  step: 2,
  log: 2,
  write: 3,
};

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
 * One timeline from the events of both feeds: duplicates (same kind and id)
 * dropped, writes attached to runs, everything sorted by time.
 */
export function mergeTimeline(
  events: readonly TimelineEvent[],
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
  let next = 0;
  return sortEvents(
    unique.map((event) => (event.kind === "write" ? writes[next++] : event)),
  );
}

/**
 * Builds a timeline while the feeds arrive, for a recorder that writes events
 * as it goes.
 *
 * The two feeds are not in step: a write can arrive before the log entry of
 * its run, or after. Thus the builder holds each event for `settleMs` after it
 * arrives, then releases it, in order, with writes attached to the runs known
 * by then. A write whose run arrives later than that stays unattached.
 */
export class TimelineBuilder {
  private pending: { event: TimelineEvent; arrival: number }[] = [];
  private runs: RunEvent[] = [];
  private seen = new Set<string>();

  constructor(private readonly settleMs: number) {}

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
      this.pending.push({ event, arrival: now });
    }
  }

  /**
   * The events that settled by `now`, in order. Pass `Infinity` to release
   * everything.
   */
  drain(now: number): TimelineEvent[] {
    const readyEvents: TimelineEvent[] = [];
    const rest: typeof this.pending = [];
    for (const item of this.pending) {
      if (item.arrival + this.settleMs <= now) {
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
    let next = 0;
    return sortEvents(
      readyEvents.map((event) =>
        event.kind === "write" ? writes[next++] : event,
      ),
    );
  }
}
