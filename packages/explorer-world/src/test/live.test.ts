import { describe, expect, test } from "vitest";
import { parseNdjson } from "../adapters/convexRecording.ts";
import {
  anchorTime,
  behindLive,
  LiveFeed,
  liveEdge,
  liveUrl,
  placedBehind,
  summarize,
} from "../live.ts";
import type { World } from "../model/world.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

const project = prepareProject(PROJECTS["convex-auth"]);
const text = project.source.timelines.page;
const lines = text.split("\n").filter((line) => line.trim() !== "");

/**
 * What does not depend on the order of events of the same millisecond: which
 * runs, which writes, what was counted and what was left unplaced.
 */
function content(world: World) {
  const { recording } = world;
  return {
    runs: recording.runs.map((r) => r.id).sort(),
    writes: recording.runs
      .flatMap((r) =>
        r.writes.map((w) => `${r.id} ${w.table} ${w.row} ${w.op}`),
      )
      .sort(),
    events: recording.events,
    unplaced: recording.unplaced,
    parts: world.graph.parts.map((p) => p.id).sort(),
  };
}

const saved = worldFromEvents(project, parseNdjson(text), "live").world;

describe("LiveFeed", () => {
  test("takes each line once, in order, and skips what it cannot read", () => {
    const feed = new LiveFeed();
    expect(feed.take(0, lines[0])).toBe(true);
    expect(feed.take(0, lines[0])).toBe(false);
    expect(feed.take(1, "not json")).toBe(true);
    expect(feed.take(2, lines[1])).toBe(true);
    expect(feed.events).toHaveLength(2);
    expect(feed.skipped).toBe(1);
  });
});

describe("a live recording", () => {
  test("built batch by batch, ends as the world of its file", () => {
    const feed = new LiveFeed();
    let world = worldFromEvents(project, [], "live").world;
    let relaidOut = 0;
    for (let i = 0; i < lines.length; i += 7) {
      lines.slice(i, i + 7).forEach((line, k) => feed.take(i + k, line));
      const next = worldFromEvents(project, feed.events, "live", world);
      if (next.relaidOut) relaidOut++;
      world = next.world;
    }
    expect(summarize(world)).toEqual(summarize(saved));
    // The layout is reused until the recording adds a part to the map.
    // The page, its elements and its storage keys are added as they first show.
    expect(relaidOut).toBeLessThan(10);
    expect(world.layout.parts.size).toBe(saved.layout.parts.size);
  });

  test("out of order, ends with the same content", () => {
    // Every line but the first, in a scrambled order: late and early events.
    const rest = lines.slice(1);
    const order = rest
      .map((line, i) => ({ line, key: (i * 7919) % rest.length }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.line);
    const events = parseNdjson([lines[0], ...order].join("\n"));
    const world = worldFromEvents(project, events, "live").world;
    // Events of the same millisecond keep the order they came in, which can
    // decide the order of two runs or which run a page item follows. The
    // stream keeps the order of the file, so live and file agree exactly
    // (above); scrambled, the content still agrees.
    expect(content(world)).toEqual(content(saved));
  });

  test("keeps the playhead in its run when a late run lands before it", () => {
    const events = parseNdjson(text);
    const runs = events.filter((e) => e.kind === "run");
    // Hold back the third run, as if it reached the world late.
    const late = runs[2];
    const without = events.filter((e) => e !== late);
    const before = worldFromEvents(project, without, "live").world;
    // A run that started after the late one, a few runs on.
    const chapter = before.timeline.chapters.find(
      (c, i) => i >= 5 && c.run.startedAt > Number(late.time),
    )!;
    const time = chapter.start + 1.3;
    const after = worldFromEvents(project, events, "live", before).world;
    const moved = anchorTime(before.timeline, time, after.timeline);
    const now = after.timeline.chapters.find(
      (c) => c.start <= moved && moved < c.end,
    );
    expect(now?.run.id).toBe(chapter.run.id);
    expect(moved - now!.start).toBeCloseTo(1.3);
    expect(placedBehind(before.timeline, time, after.timeline)).toBe(1);
  });

  test("says how far behind the newest run the playhead is", () => {
    const { timeline } = saved;
    expect(behindLive(timeline, timeline.duration)).toEqual({
      seconds: 0,
      runs: 0,
    });
    const first = behindLive(timeline, 0);
    expect(first.runs).toBe(timeline.chapters.length);
    expect(first.seconds).toBeCloseTo(timeline.duration);
    expect(liveEdge(timeline)).toBe(
      Math.max(
        timeline.chapters[timeline.chapters.length - 1].start,
        ...timeline.actions,
      ),
    );
  });

  test("takes a stream only from this machine", () => {
    expect(liveUrl(null)).toBeNull();
    expect(liveUrl("http://127.0.0.1:5199/timeline")?.port).toBe("5199");
    expect(() => liveUrl("http://example.com/timeline")).toThrow();
    expect(() => liveUrl("https://127.0.0.1:5199/timeline")).toThrow();
  });
});
