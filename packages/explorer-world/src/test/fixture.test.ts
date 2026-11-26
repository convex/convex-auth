/**
 * The world shows any Convex project from its data alone: a made-up chat app
 * with one component (`fixtures/chat`) loads, lays out and plays through the
 * same code as Convex Auth, with no code of its own.
 */
import { describe, expect, test } from "vitest";
import { loadProject, PROJECTS } from "../project.ts";

const world = loadProject(PROJECTS.chat);

describe("a made-up chat app", () => {
  test("every part has a place and every dependency has two ends", () => {
    for (const p of world.graph.parts)
      expect(world.layout.parts.has(p.id), p.id).toBe(true);
    expect(world.layout.unplaced).toEqual([]);
    for (const l of world.graph.links) {
      expect(world.layout.parts.has(l.from), l.from).toBe(true);
      expect(world.layout.parts.has(l.to), l.to).toBe(true);
    }
    expect(world.graph.unresolved).toHaveLength(1);
  });

  test("the app, its component and its callers are where the layout puts them", () => {
    const island = (id: string) =>
      world.layout.islands.find((i) => i.id === id);
    expect(island("component:presence")?.zone).toBe("platform");
    expect(island("app:chat")?.parentIsland).toBe("region:app");
    expect(world.layout.parts.get("fn:presence:public.heartbeat")?.island).toBe(
      "component:presence",
    );
    // Callers come from the recording and stand on the platform's rim.
    expect(world.layout.parts.get("caller:Websocket")?.island).toBeNull();
    expect(world.layout.parts.get("caller:Scheduler")?.island).toBeNull();
  });

  test("the recording plays: runs, steps, writes, a log, and the derived facts", () => {
    const { runs, events, unplaced } = world.recording;
    expect(runs.map((r) => r.function)).toEqual([
      "fn:app:chat:messages.send",
      "fn:app:chat:messages.list",
      "fn:app:chat:messages.prune",
    ]);
    expect(events.run).toEqual({ seen: 3, played: 3 });
    expect(events.step).toEqual({ seen: 3, played: 3 });
    expect(events.log).toEqual({ seen: 1, played: 1 });
    expect(events.write).toEqual({ seen: 4, played: 4 });
    // A kind of event the world does not know is counted, not dropped silently.
    expect(events.page).toEqual({ seen: 1, played: 0 });
    expect(unplaced.map((u) => u.what)).toEqual(['1 event of kind "page"']);

    const [send, , prune] = runs;
    expect(send.steps.map((s) => s.kind)).toEqual(["call", "return", "note"]);
    expect(send.writes.map((w) => `${w.op} ${w.table}`)).toEqual([
      "insert table:app:chat.messages",
      "update table:presence.rooms",
    ]);
    // Not stated by the recording: which run scheduled the prune, and which run deleted the message.
    expect(prune.scheduledBy?.run).toBe("run-1");
    expect(prune.scheduledBy?.derived?.rule).toBe("scheduled-by-structure");
    expect(prune.writes[0].derived?.rule).toBe("write-by-commit-time");
    expect(prune.tone).toBe("warn");
  });

  test("the state of the world follows the timeline", () => {
    const tl = world.timeline;
    const [send, list, prune] = tl.chapters;
    expect(tl.duration).toBeGreaterThan(0);
    // The snapshot row is there from the start.
    expect(
      world
        .stateAt(0)
        .tables.get("table:presence.rooms")
        ?.map((r) => r.doc.status),
    ).toEqual(["away"]);
    const afterSend = world.stateAt(send.end);
    expect(afterSend.tables.get("table:app:chat.messages")).toHaveLength(1);
    expect(afterSend.tables.get("table:presence.rooms")?.[0].doc.status).toBe(
      "here",
    );
    expect(
      world.stateAt(list.end).tables.get("table:app:chat.messages"),
    ).toHaveLength(1);
    const after =
      world.stateAt(prune.end).tables.get("table:app:chat.messages") ?? [];
    expect(after.map((r) => r.deletedAt !== undefined)).toEqual([true]);
    expect(world.stateAt(prune.start + 3).alerts.map((a) => a.text)).toEqual([
      "pruning 1 message",
    ]);
  });
});
