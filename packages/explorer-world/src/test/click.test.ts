/**
 * What a click shows, and what a part opened up shows, on Convex Auth's
 * page recording: the line in the source's own words, what the part has
 * done (from the recording only), and the links lit by default and with
 * the detail asked for.
 */
import { structure } from "@convex-dev/explorer-structure";
import { describe, expect, test } from "vitest";
import { contactsOf, doneBy, doneIn, lighting } from "../model/done.ts";
import { loadProject, PROJECTS } from "../project.ts";

const source = PROJECTS["convex-auth"];
const inside = source.inside!;
const world = loadProject(source, "page");
const done = doneIn(world.recording, world.timeline, inside);
const SM = "module:browser/sessionManager";
const END = world.timeline.duration;

describe("what this is", () => {
  test("a module without a doc comment takes its one class's line, and says so", () => {
    expect(inside.parts[SM].summary).toEqual({
      text: "Framework-agnostic owner of the auth session on the client.",
      from: "AuthClient",
    });
  });

  test("a module with a doc comment has its own line", () => {
    expect(inside.parts["module:browser/retry"].summary).toEqual({
      text: "Retry policy for the client's auth calls (session refresh, OAuth code redemption).",
    });
  });

  test("a hook has the line of its export", () => {
    const hook = Object.keys(inside.parts).find((id) => id.startsWith("hook:"));
    expect(hook).toBeDefined();
    expect(inside.parts[hook!].summary?.text.length).toBeGreaterThan(0);
  });

  test("no line is made up: every line is in the structure map", () => {
    const lines = new Set<string>();
    for (const m of Object.values(structure.modules ?? {})) {
      if (m.summary) lines.add(m.summary);
      for (const e of m.exports) if (e.summary) lines.add(e.summary);
    }
    for (const p of Object.values(inside.parts))
      if (p.summary)
        expect(lines.has(p.summary.text), p.summary.text).toBe(true);
  });
});

describe("what it has done", () => {
  test("nothing before anything ran", () => {
    expect(doneBy(done, SM, -1).hits).toEqual([]);
  });

  test("the session manager reported some of its 24 steps, each at a site in its code", () => {
    const so = doneBy(done, SM, END);
    expect(inside.parts[SM].sites).toHaveLength(24);
    expect(so.count).toBeGreaterThan(5);
    expect(so.count).toBeLessThan(24);
    const ids = new Set(inside.parts[SM].sites.map((s) => s.id));
    for (const h of so.hits)
      for (const s of h.sites) expect(ids.has(s)).toBe(true);
  });

  test("a lock step it reports as the mutex is counted on the session manager, whose code ran", () => {
    const steps = doneBy(done, SM, END).hits.map((h) => h.step);
    expect(steps).toContain("lock.acquired");
    expect(doneBy(done, "module:browser/mutex", END).hits).toEqual([]);
  });
});

describe("what a click lights", () => {
  const storage = "module:browser/storage";

  test("by default: only who it dealt with in the recording", () => {
    const lit = lighting(world.index, done, new Set([storage]), END, false);
    expect(lit.links).toEqual([]);
    expect(lit.unresolved).toEqual([]);
    expect([...lit.linked.keys()].sort()).toEqual(
      contactsOf(done, new Set([storage]), END)
        .map((c) => c.other)
        .sort(),
    );
    expect(lit.linked.size).toBeGreaterThan(0);
    for (const other of lit.linked.keys())
      expect(other.startsWith("storageKey:")).toBe(true);
  });

  test("a part that dealt with no one yet lights nothing", () => {
    const lit = lighting(world.index, done, new Set([SM]), -1, false);
    expect(lit.linked.size).toBe(0);
  });

  test("with the detail asked for: its links in the source and the unresolved ones", () => {
    const lit = lighting(world.index, done, new Set([SM]), END, true);
    const own = [
      ...(world.index.out.get(SM) ?? []),
      ...(world.index.in.get(SM) ?? []),
    ];
    expect(lit.links).toHaveLength(own.length);
    expect(lit.unresolved).toHaveLength(
      world.index.unresolvedFrom.get(SM)?.length ?? 0,
    );
    expect(lit.unresolved.length).toBeGreaterThan(0);
  });
});
