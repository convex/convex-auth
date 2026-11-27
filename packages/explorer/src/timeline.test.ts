import { describe, expect, test } from "vitest";
import type {
  RunEvent,
  StepEvent,
  TimelineEvent,
  WriteEvent,
} from "./events.ts";
import { eventsFromLogEntry } from "./logs.ts";
import { convexAuthProject } from "./projects/convexAuth.ts";
import { SyncReader } from "./sync.ts";
import { logEntries, syncPages } from "./testFixtures.ts";
import {
  LOG_MARGIN_MS,
  mergeTimeline,
  runForCommit,
  TimelineBuilder,
} from "./timeline.ts";

function fixtureEvents(): TimelineEvent[] {
  const reader = new SyncReader(convexAuthProject);
  const writes = syncPages.flatMap((page) => reader.read(page).writes);
  const logs = logEntries.flatMap((entry) => {
    const { run, lines } = eventsFromLogEntry(entry);
    return run === null ? lines : [run, ...lines];
  });
  // The feeds arrive interleaved; the order of the input must not matter.
  return [...writes, ...logs];
}

const timeline = mergeTimeline(fixtureEvents());
const runs = timeline.filter(
  (event): event is RunEvent => event.kind === "run",
);
const writes = timeline.filter(
  (event): event is WriteEvent => event.kind === "write",
);
const runOf = (write: WriteEvent) =>
  runs.find((run) => run.id === write.runId)?.identifier ?? null;

describe("mergeTimeline", () => {
  test("holds every run of the logs, in order of time", () => {
    expect(runs.map((run) => run.identifier)).toEqual([
      "auth:signUpWithUsernamePassword",
      "auth:signInWithUsernamePassword",
      "auth:refreshSession",
      "auth:refreshSession",
      "auth:refreshSession",
      "sessions:deleteSessionTokens",
      "auth:signOut",
      "sessions:deleteSessionTokens",
      "auth:signInWithUsernamePassword",
    ]);
    const times = timeline.map((event) => event.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("attaches every write after the snapshot to the run that made it", () => {
    const live = writes.filter((write) => !write.snapshot);
    expect(live.every((write) => write.runId !== null)).toBe(true);
    for (const run of runs) {
      const own = live.filter((write) => write.runId === run.id);
      expect(own.length, run.identifier).toBe(run.writeCount);
    }
  });

  test("the writes of one transaction share one run", () => {
    const byTs = new Map<string, Set<string | null>>();
    for (const write of writes) {
      byTs.set(write.ts, (byTs.get(write.ts) ?? new Set()).add(write.runId));
    }
    for (const runIds of byTs.values()) {
      expect(runIds.size).toBe(1);
    }
  });

  test("shows the lifecycle of a refresh token", () => {
    const signIn = runs[1];
    const issued = writes.find(
      (write) =>
        write.runId === signIn.id &&
        write.table === "refreshTokens" &&
        write.value?.state === "issued",
    )!;
    const history = writes
      .filter((write) => write.documentId === issued.documentId)
      .map((write) => [
        write.deleted ? "deleted" : write.value!.state,
        runOf(write),
      ]);
    expect(history).toEqual([
      ["issued", "auth:signInWithUsernamePassword"],
      ["redeemed", "auth:refreshSession"],
      ["spent", "auth:refreshSession"],
      ["deleted", "sessions:deleteSessionTokens"],
    ]);
  });

  test("the scheduled deletes of a revoked session belong to their run", () => {
    const cleanup = runs.find(
      (run) => run.identifier === "sessions:deleteSessionTokens",
    )!;
    const own = writes.filter((write) => write.runId === cleanup.id);
    expect(own.map((write) => [write.table, write.deleted])).toEqual([
      ["refreshTokens", true],
      ["refreshTokens", true],
      ["refreshTokens", true],
    ]);
  });

  test("puts the steps of a run after its start, in order", () => {
    const signUp = runs[0];
    const steps = timeline.filter(
      (event): event is StepEvent =>
        event.kind === "step" && event.runId === signUp.id,
    );
    expect(steps.map((step) => step.id)).toEqual(
      steps.map((_, index) => `${signUp.id}#${index}`),
    );
    expect(timeline.indexOf(signUp)).toBeLessThan(timeline.indexOf(steps[0]));
  });

  test("keeps a write that matches no run, unattached", () => {
    const orphan = { ...writes[0], id: "x", ts: "1", time: 1, runId: null };
    const merged = mergeTimeline([...fixtureEvents(), orphan]);
    expect(merged[0]).toEqual(orphan);
  });

  test("drops duplicates", () => {
    expect(mergeTimeline([...fixtureEvents(), ...fixtureEvents()])).toEqual(
      timeline,
    );
  });

  test("holds no secret", () => {
    const text = timeline.map((event) => JSON.stringify(event)).join("\n");
    expect(text).not.toMatch(/ffffffffffffffff/);
    expect(text).not.toMatch(/argon2/);
    expect(text).toMatch(/"hash":"\[redacted\]"/);
  });
});

describe("runForCommit", () => {
  const run: RunEvent = {
    ...runs[0],
    time: 1000,
    endTime: 1100,
    writeCount: 2,
  };

  test("matches a commit inside the window of a successful mutation", () => {
    expect(runForCommit([run], 1050, 2)).toBe(run);
    expect(runForCommit([run], 1200, 2)).toBeNull();
    expect(runForCommit([{ ...run, ok: false }], 1050, 2)).toBeNull();
    expect(runForCommit([{ ...run, udfType: "Query" }], 1050, 2)).toBeNull();
  });

  test("among overlapping runs, prefers the one whose write count matches", () => {
    const other = { ...run, id: "other", writeCount: 5 };
    expect(runForCommit([other, run], 1099, 2)).toBe(run);
    expect(runForCommit([run, other], 1099, 5)).toBe(other);
  });
});

describe("TimelineBuilder", () => {
  test("holds events until they settle, then attaches writes", () => {
    const builder = new TimelineBuilder(1000);
    const events = fixtureEvents();
    const writesFirst = events.filter((event) => event.kind === "write");
    const logsLater = events.filter((event) => event.kind !== "write");
    builder.add(writesFirst, 0);
    builder.add(logsLater, 500);
    expect(builder.drain(900)).toEqual([]);
    const first = builder.drain(1000);
    expect(first.every((event) => event.kind === "write")).toBe(true);
    expect(
      first.filter(
        (event) => event.kind === "write" && !event.snapshot && event.runId,
      ),
    ).toHaveLength(
      first.filter((e) => e.kind === "write" && !e.snapshot).length,
    );
    const rest = builder.drain(Infinity);
    expect(rest.length).toBe(logsLater.length);
    builder.add(events, 2000);
    expect(builder.drain(Infinity)).toEqual([]);
  });

  test("with early, releases at once what waits on nothing, and the rest once the logs are read", () => {
    const builder = new TimelineBuilder(3000, { early: true });
    const events = fixtureEvents();
    const writes = events.filter(
      (event) => event.kind === "write" && !event.snapshot,
    );
    const others = events.filter((event) => !writes.includes(event));
    builder.add(writes, 0);
    builder.add(others, 10);
    // The runs and lines are out; the writes wait for the log stream.
    const first = builder.drain(20);
    expect(first.length).toBe(others.length);
    expect(builder.waitingForLogs()).toBe(LOG_MARGIN_MS);
    builder.logsReadUntil(LOG_MARGIN_MS - 1);
    expect(builder.drain(30)).toEqual([]);
    builder.logsReadUntil(LOG_MARGIN_MS);
    expect(builder.waitingForLogs()).toBeNull();
    const released = builder.drain(30);
    expect(released.length).toBe(writes.length);
    // Attached as the whole timeline attaches them.
    expect(
      released.map((event) => (event.kind === "write" ? event.runId : null)),
    ).toEqual(
      timeline
        .filter(
          (event): event is WriteEvent =>
            event.kind === "write" && !event.snapshot,
        )
        .map((write) => write.runId),
    );
  });

  test("with early, still releases a waiting event after settleMs", () => {
    const builder = new TimelineBuilder(1000, { early: true });
    const write = fixtureEvents().find(
      (event) => event.kind === "write" && !event.snapshot,
    )!;
    builder.add([write], 0);
    expect(builder.drain(999)).toEqual([]);
    expect(builder.drain(1000)).toHaveLength(1);
  });
});
