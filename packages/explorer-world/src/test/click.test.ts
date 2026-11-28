/**
 * What a click shows, and what a part opened up shows, on Convex Auth's
 * page recording: the line in the source's own words, what the part has
 * done (from the recording only), the links lit by default and with the
 * detail asked for, and the inside of a module from the structure map.
 */
import { structure } from "@convex-dev/explorer-structure";
import { describe, expect, test } from "vitest";
import { contactsOf, doneBy, doneIn, lighting } from "../model/done.ts";
import { layInside } from "../model/insideLayout.ts";
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

describe("a part opened up", () => {
  test("the session manager: AuthClient in the middle, its 11 members around it", () => {
    const lay = layInside(inside.parts[SM]);
    const main = lay.places.find((p) => p.x === 0 && p.z === 0)!;
    expect(main.place.name).toBe("AuthClient");
    expect(lay.places.filter((p) => p.shape === "member")).toHaveLength(11);
    expect(
      lay.holds
        .filter((h) => h.kind === "key")
        .map((h) => h.name)
        .sort(),
    ).toEqual(["__convexAuthJWT", "__convexAuthRefreshToken"]);
    const lock = lay.holds.find((h) => h.kind === "lock")!;
    const key = lay.holds.find((h) => h.name === "__convexAuthRefreshToken")!;
    expect([lock.x, lock.z]).toEqual([key.x, key.z]);
  });

  test("each step mark sits on the place its code is in", () => {
    const lay = layInside(inside.parts[SM]);
    expect(lay.sites).toHaveLength(24);
    const at = (step: string) => lay.sites.find((s) => s.step === step)!.place;
    expect(at("token.fetch")).toBe("AuthClient.fetchAccessToken");
    expect(at("session.set")).toBe("AuthClient.setSession");
    expect(at("refresh.start")).toBe("AuthClient");
  });

  test("a hook is not drawn again inside its module", () => {
    const withHooks = Object.values(inside.parts).find((p) =>
      p.places.some((x) => x.part),
    )!;
    const lay = layInside(withHooks);
    expect(lay.places.some((p) => p.place.part)).toBe(false);
  });

  test("every module opens from the same data", () => {
    for (const [id, p] of Object.entries(inside.parts)) {
      if (!id.startsWith("module:")) continue;
      const lay = layInside(p);
      for (const s of lay.sites)
        expect(Number.isFinite(s.x + s.z), id).toBe(true);
      const names = lay.places.map((x) => x.place.id);
      expect(new Set(names).size, id).toBe(names.length);
    }
  });
});

describe("what the page reported on load", () => {
  test("counts before any run: the card and the group agree", async () => {
    const { parseNdjson } = await import("../adapters/convexRecording.ts");
    const { prepareProject, worldFromEvents } = await import("../project.ts");
    const { takenPart } = await import("../model/takenPart.ts");
    const events = parseNdjson(source.timelines.page);
    const firstRun = events.findIndex((e) => e.kind === "run");
    const onLoad = events.slice(0, firstRun);
    const w = worldFromEvents(prepareProject(source), onLoad, "load").world;
    expect(w.recording.runs).toHaveLength(0);
    expect(w.recording.early?.some((it) => it.step)).toBe(true);
    const d = doneIn(w.recording, w.timeline, inside);
    const so = doneBy(d, SM, w.timeline.duration);
    expect(so.count).toBeGreaterThan(0);
    const taken = takenPart(
      w.index,
      w.layout,
      w.timeline,
      w.presentation.focus,
    );
    const group = taken.groupOf.get(SM)!;
    expect(taken.groups.has(group.id)).toBe(true);
  });
});

describe("names on an open disc", () => {
  test("every member is named from where Open up puts the camera, and no step's name outranks one", async () => {
    const { insideNames, OPEN_UP_DISTANCE } =
      await import("../model/insideLayout.ts");
    const lay = layInside(inside.parts[SM]);
    const lit = new Set(doneBy(done, SM, END).hits.flatMap((h) => h.sites));
    const names = insideNames(lay, lit);
    const members = lay.places.filter((p) => p.shape === "member");
    const steps = names.filter((n) => n.kind === "steps");
    expect(steps.length).toBeGreaterThan(0);
    const lowest = Math.min(
      ...names.filter((n) => n.kind === "member").map((n) => n.priority),
    );
    for (const m of members) {
      const n = names.find((x) => x.key === m.place.id)!;
      expect(n, m.place.name).toBeDefined();
      expect(n.far).toBeGreaterThan(OPEN_UP_DISTANCE);
    }
    for (const s of steps) expect(s.priority).toBeLessThan(lowest);
  });

  test("a step not reported has no name; a reported one is under its place", async () => {
    const { insideNames } = await import("../model/insideLayout.ts");
    const lay = layInside(inside.parts[SM]);
    expect(insideNames(lay, new Set()).some((n) => n.kind === "steps")).toBe(
      false,
    );
    const fetch = lay.sites.find((s) => s.step === "token.fetch")!;
    const n = insideNames(lay, new Set([fetch.id])).find(
      (x) => x.kind === "steps",
    )!;
    expect(n.place).toBe("AuthClient.fetchAccessToken");
    expect(n.text).toBe("token.fetch");
  });
});

describe("the card's way there", () => {
  test("an open part the camera is not at still offers Open up; framed, nothing", async () => {
    const { wayThere } = await import("../ui/cardRules.ts");
    expect(wayThere("module:a", true, null)).toBe("open");
    expect(wayThere("module:a", true, "module:b")).toBe("open");
    expect(wayThere("module:a", true, "module:a")).toBe(null);
    expect(wayThere("module:a", false, "module:a")).toBe("go");
  });

  test("it stands clear of the point, its name above it and its arcs", async () => {
    const { placeCard } = await import("../ui/cardRules.ts");
    const fit = { W: 1440, H: 810, w: 286, h: 160, aside: false };
    const p = placeCard({ ...fit, at: { x: 600, y: 300 } });
    expect(p.x).toBeGreaterThan(600);
    expect(p.y).toBeGreaterThan(300);
    const low = placeCard({ ...fit, at: { x: 1300, y: 700 } });
    expect(low.x + 286).toBeLessThan(1300);
    expect(low.y + 160).toBeLessThan(700 - 60);
    expect(placeCard({ ...fit, at: { x: 600, y: 300 }, aside: true })).toEqual({
      x: 16,
      y: 16,
    });
  });

  test("a line that introduces a list loses its colon", async () => {
    const { cardLine } = await import("../ui/cardRules.ts");
    expect(cardLine("Access the auth actions:")).toBe(
      "Access the auth actions",
    );
    expect(cardLine("Owner of the session.")).toBe("Owner of the session.");
  });
});
