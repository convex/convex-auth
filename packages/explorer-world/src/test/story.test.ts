/**
 * Stories (`model/story.ts`) on a recorded reload of the page in
 * development (`fixtures/reload.ndjson`: the recorder's page and step
 * events of a run that pressed "Reload the page" once).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseNdjson, type Event } from "../adapters/convexRecording.ts";
import { allLines, playByPlayOf } from "../model/playByPlay.ts";
import {
  bindStory,
  matches,
  playUntil,
  readStory,
  stopHolds,
  type Story,
} from "../model/story.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

const project = prepareProject(PROJECTS["convex-auth"]);
const events = parseNdjson(
  readFileSync(new URL("./fixtures/reload.ndjson", import.meta.url), "utf8"),
);
const sectionsOf = (evs: Event[]) =>
  playByPlayOf(worldFromEvents(project, evs, "live").world);
const sections = sectionsOf(events);
const story = project.source.stories!.find(
  (s) => s.id === "who-starts-the-client",
)!;

/** A story on the reload, with the stops given. */
const reloadStory = (stops: Story["stops"]): Story => ({
  id: "test",
  title: "Test",
  press: { action: "reload", label: "Reload the page" },
  stops,
});

describe("a line is found", () => {
  const lines = allLines(sections);
  test("by its step, the part that reported it and its report", () => {
    const read = lines.find(
      (l) => l.step === "storage.read" && l.detail?.key === "__convexAuthJWT",
    )!;
    expect(matches(read, { step: "storage.read" })).toBe(true);
    expect(
      matches(read, {
        step: "storage.read",
        who: "module:browser/storage",
        detail: { key: "__convexAuthJWT", found: false },
      }),
    ).toBe(true);
    expect(
      matches(read, {
        step: "storage.read",
        detail: { key: "__convexAuthRefreshToken" },
      }),
    ).toBe(false);
    expect(matches(read, { who: "module:browser/sessionManager" })).toBe(false);
  });

  test("an operation by its own line, not its steps", () => {
    const op = lines.find((l) => l.mark === "op" && l.opKind === "init")!;
    expect(matches(op, { op: "init" })).toBe(true);
    const step = lines.find((l) => l.step === "init")!;
    expect(matches(step, { op: "init" })).toBe(false);
  });

  test("nothing to match finds nothing", () => {
    expect(lines.some((l) => matches(l, {}))).toBe(false);
  });
});

describe("story 1 on a reload", () => {
  const bound = bindStory(story, sections);

  test("binds to the press, and every stop holds", () => {
    expect(bound.section?.title).toBe("Reload the page");
    const failing = bound.stops
      .filter((b) => b.status !== "note" && !stopHolds(b))
      .map((b) => b.stop.say);
    expect(failing).toEqual([]);
    // The last stop is a note, never shown as having happened.
    expect(bound.stops.at(-1)!.status).toBe("note");
    expect(bound.stops.at(-1)!.line).toBeUndefined();
  });

  test("each pin is looked for after the stop before", () => {
    const [mount, start, reads, , gap, again, restart, settled] = bound.stops;
    expect(start.line!.at).toBeGreaterThanOrEqual(mount.line!.at);
    expect(reads.line!.detail?.key).toBe("__convexAuthJWT");
    expect(reads.to!.detail?.key).toBe("__convexAuthRefreshToken");
    // The second mount and start are the ones after the stop.
    expect(again.line!.at).toBeGreaterThan(gap.line!.at);
    expect(restart.line!.op).not.toBe(start.line!.op);
    // Memory takes what was read after the second start: in the first one.
    expect(settled.line!.at).toBeGreaterThan(restart.line!.at);
    expect(settled.line!.op).toBe(start.line!.op);
  });

  test("play to next holds at the next stop's line", () => {
    expect(playUntil(bound.stops, 0)).toBe(bound.stops[1].line!.at + 0.02);
    // The last pinned stop goes on to nothing.
    expect(playUntil(bound.stops, 7)).toBeNull();
  });
});

describe("a stop that did not happen", () => {
  test("says so, once the press is over", () => {
    const bound = bindStory(
      reloadStory([
        { say: "Signs out.", pin: { step: "signOut.start" } },
        { say: "Mounts.", pin: { step: "provider.mount" } },
      ]),
      sections,
    );
    expect(bound.stops.map((b) => b.status)).toEqual(["missing", "holds"]);
  });

  test("a check that does not hold, in either direction", () => {
    const [b] = bindStory(
      reloadStory([
        {
          say: "Starts.",
          pin: { op: "init" },
          checks: [
            { say: "Reads storage.", has: { step: "storage.read" } },
            { say: "Does not listen.", not: { step: "crossTab.listen" } },
            { say: "Never signs out.", not: { step: "signOut.start" } },
          ],
        },
      ]),
      sections,
    ).stops;
    expect(b.checks.map((c) => c.status)).toEqual([
      "holds",
      "missing",
      "holds",
    ]);
    expect(b.checks[1].line?.step).toBe("crossTab.listen");
    expect(stopHolds(b)).toBe(false);
  });
});

describe("while the press is being recorded", () => {
  const scenario = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === "scenario");
  const [start, end] = scenario.map((x) => x.i);

  test("before the press, the story waits for it", () => {
    const bound = bindStory(story, sectionsOf(events.slice(0, start)));
    expect(bound.section).toBeNull();
    expect(
      bound.stops.every((b) => b.status === "waiting" || b.status === "note"),
    ).toBe(true);
  });

  test("what has arrived holds; what has not waits, it is not missing", () => {
    // Up to the second mount: the rest of the press has not arrived.
    const cut = events.findIndex(
      (e, i) =>
        i > start &&
        e.kind === "step" &&
        e.step === "provider.mount" &&
        events
          .slice(start, i)
          .some((x) => x.kind === "step" && x.step === "dispose"),
    );
    const bound = bindStory(story, sectionsOf(events.slice(0, cut)));
    expect(bound.section?.closed).toBe(false);
    expect(bound.stops.slice(0, 4).every(stopHolds)).toBe(true);
    expect(bound.stops.slice(5, 8).map((b) => b.status)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  test("that nothing was read is known only when the press is over", () => {
    const upTo = (n: number) =>
      bindStory(story, sectionsOf(events.slice(0, n))).stops[6];
    const open = upTo(end);
    expect(open.status).toBe("holds");
    expect(open.checks.map((c) => c.status)).toEqual([
      "holds",
      "waiting",
      "waiting",
    ]);
    expect(upTo(end + 1).checks.every((c) => c.status === "holds")).toBe(true);
  });

  test("a press from before the story started is not used", () => {
    const bound = bindStory(story, sections, { since: Infinity });
    expect(bound.section).toBeNull();
  });
});

test("a story with no words, no stops or nothing to match is refused", () => {
  const ok = { id: "a", title: "A", stops: [{ say: "Hi." }] };
  expect(readStory(ok, "a").stops).toHaveLength(1);
  expect(() => readStory({ ...ok, stops: [] }, "a")).toThrow(/no stops/);
  expect(() => readStory({ ...ok, stops: [{ say: " " }] }, "a")).toThrow(
    /says nothing/,
  );
  expect(() =>
    readStory({ ...ok, stops: [{ say: "x", pin: { nth: 2 } }] }, "a"),
  ).toThrow(/nothing to match/);
  expect(() =>
    readStory(
      { ...ok, stops: [{ say: "x", checks: [{ say: "y", has: {} }] }] },
      "a",
    ),
  ).toThrow(/no pin/);
});
