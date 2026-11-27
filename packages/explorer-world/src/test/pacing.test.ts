import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { hurry, liveEdge, nextStart } from "../live.ts";
import {
  HOP,
  HOP_KEY,
  LONGEST_WAIT,
  RERUN,
  shownAt,
  shownGap,
} from "../model/schedule.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

// A live session of the username-password example: three controls pressed
// (sign up, sign out, sign in), recorded by `explorer:live`.
const events = parseNdjson(
  readFileSync(
    new URL("./fixtures/live-actions.ndjson", import.meta.url),
    "utf8",
  ),
);
const project = prepareProject(PROJECTS["convex-auth"]);
const { world } = worldFromEvents(project, events, "live");
const tl = world.timeline;

/**
 * Shown time from a pressed control to the end of the last thing that
 * started before it was done.
 */
const spans = tl.actions.map((start, i) => {
  const done = tl.actionEnds[i];
  const ends = [
    ...tl.movements.map((m) => [m.start, m.end]),
    ...tl.clientSteps.map((s) => [s.start, s.end]),
  ]
    .filter(([s]) => s >= start && s <= done)
    .map(([, e]) => e);
  return Math.max(done, ...ends) - start;
});

describe("pacing", () => {
  test("each pressed control plays out in about 12 seconds or less", () => {
    expect(tl.actions).toHaveLength(3);
    expect(tl.actionEnds).toHaveLength(3);
    const [signUp, signOut, signIn] = spans;
    for (const s of spans) expect(s).toBeGreaterThan(2);
    // Sign-in with the token fetch that follows it.
    expect(signIn).toBeLessThanOrEqual(13);
    expect(signOut).toBeLessThanOrEqual(12);
    // Sign-up loads the page again first: the client starts up, then signs
    // in, then fetches its first token.
    expect(signUp).toBeLessThanOrEqual(16.5);
  });

  test("an operation's body takes at least a hop to get from one place to the next", () => {
    let hops = 0;
    // What nobody asked for plays briefly (BRIEF), at half the hops.
    for (const op of tl.ops.filter((o) => !o.unasked))
      for (let i = 1; i < op.points.length; i++) {
        const [a, b] = [op.points[i - 1], op.points[i]];
        if (a.anchor === b.anchor) continue;
        hops++;
        const key = [a.anchor, b.anchor].some((x) =>
          x.startsWith("storageKey:"),
        );
        expect(b.at - a.at).toBeGreaterThanOrEqual(
          (key ? HOP_KEY : HOP) - 1e-9,
        );
      }
    expect(hops).toBeGreaterThan(40);
  });

  test("what the client does by itself between pressed controls plays briefly", () => {
    const own = tl.ops.filter((o) => o.unasked && o.kind === "tokenFetch");
    expect(own.length).toBeGreaterThanOrEqual(3);
    const asked = tl.ops.filter(
      (o) => !o.unasked && o.kind === "tokenFetch" && o.run,
    );
    expect(asked.length).toBeGreaterThan(0);
    const length = (o: (typeof own)[number]) =>
      o.points.at(-1)!.at - o.points[0].at;
    const longest = Math.max(...own.map(length));
    expect(longest).toBeLessThan(Math.min(...asked.map(length)) * 0.75);
    // No pressed control's start is drawn for it.
    expect(tl.actions).toHaveLength(3);
  });

  test("shown time is one increasing function of real time", () => {
    const { real, shown } = tl.warp;
    expect(real.length).toBeGreaterThan(10);
    for (let i = 1; i < real.length; i++) {
      expect(real[i]).toBeGreaterThan(real[i - 1]);
      expect(shown[i]).toBeGreaterThan(shown[i - 1]);
    }
    expect(shownAt(tl.warp, real[0] - 1000)).toBe(shown[0]);
  });

  test("a long real wait is a short pause", () => {
    expect(shownGap(0.2)).toBeCloseTo(0.2);
    expect(shownGap(50)).toBeLessThanOrEqual(LONGEST_WAIT);
    expect(shownGap(5)).toBeLessThan(shownGap(50));
    // Half a minute of nobody pressing anything, a lock held for a
    // scheduled refresh: each is a pause of at most LONGEST_WAIT (and a
    // run that was in flight across it may finish playing first).
    const { real, shown } = tl.warp;
    let long = 0;
    for (let i = 1; i < real.length; i++)
      if (real[i] - real[i - 1] > 5000) {
        long++;
        expect(shown[i] - shown[i - 1]).toBeLessThanOrEqual(LONGEST_WAIT + 1);
      }
    expect(long).toBeGreaterThanOrEqual(3);
  });

  test("a query run again plays briefly", () => {
    const counts = new Map<string, number>();
    for (const c of tl.chapters) {
      const key = `${c.run.caller}|${c.run.function}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > 1 && c.run.type === "Query")
        expect(c.end - c.start).toBeLessThanOrEqual(RERUN + 1e-9);
    }
  });

  test("what happened at the same time plays at the same time", () => {
    // Runs in flight together overlap on the timeline.
    const overlapping = tl.chapters.some((c, i) =>
      tl.chapters.slice(i + 1).some((d) => d.start < c.end),
    );
    expect(overlapping).toBe(true);
  });

  test("a newer pressed control makes the one playing finish within a second or so", () => {
    const [first, second] = tl.actions;
    const mid = (first + second) / 2;
    const cut = { ...tl, actions: [first, second] };
    expect(hurry(cut, mid)).toBeGreaterThanOrEqual(3);
    expect((second - mid) / hurry(cut, mid)).toBeLessThanOrEqual(1.01);
    // The newest one plays at shown speed.
    expect(hurry({ ...cut, duration: second + 10 }, second + 0.5)).toBe(1);
    expect(liveEdge(cut)).toBeGreaterThanOrEqual(second);
    expect(nextStart(tl, second - 0.01)).toBeCloseTo(second, 5);
  });
});
