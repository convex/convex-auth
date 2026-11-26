/**
 * Convex Auth: the whole structure map, and a real recording of the
 * username-password example (sign up, sign in, two refreshes, the reuse of a
 * spent refresh token and the cleanup it schedules, a wrong password).
 */
import { describe, expect, test } from "vitest";
import { loadProject, PROJECTS } from "../project.ts";

const world = loadProject(PROJECTS["convex-auth"]);
const REFRESH = "table:auth.refreshTokens";

describe("the map of Convex Auth", () => {
  test("every part has a place and every dependency is drawable", () => {
    const placed = world.graph.parts.filter((p) =>
      world.layout.parts.has(p.id),
    );
    expect(placed.length).toBe(world.graph.parts.length);
    expect(world.layout.unplaced).toEqual([]);
    const drawable = world.graph.links.filter(
      (l) => world.layout.parts.has(l.from) && world.layout.parts.has(l.to),
    );
    expect(drawable.length).toBe(world.graph.links.length);
    expect(world.graph.unresolved.length).toBeGreaterThan(0);
  });

  test("the recording adds only the parts the map lacks, marked as observed", () => {
    expect(
      world.graph.parts
        .filter((p) => p.observed)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["caller:HttpApi", "caller:Scheduler"]);
  });

  test("no two parts on an island overlap", () => {
    for (const island of world.layout.islands) {
      const ps = island.members.map((m) => world.layout.parts.get(m)!);
      for (let i = 0; i < ps.length; i++)
        for (let j = i + 1; j < ps.length; j++) {
          const d = Math.hypot(
            ps[i].position[0] - ps[j].position[0],
            ps[i].position[2] - ps[j].position[2],
          );
          expect(d, `${ps[i].id} / ${ps[j].id}`).toBeGreaterThanOrEqual(
            ps[i].radius + ps[j].radius - 1e-6,
          );
        }
    }
  });
});

describe("the recording", () => {
  const { runs, events } = world.recording;

  test("plays every event", () => {
    expect(events).toEqual({
      recording: { seen: 1, played: 1 },
      run: { seen: 7, played: 7 },
      step: { seen: 35, played: 35 },
      log: { seen: 1, played: 1 },
      write: { seen: 20, played: 20 },
    });
    expect(world.recording.unplaced).toEqual([]);
  });

  test("maps every run and call to a function of the map", () => {
    expect(runs.map((r) => `${r.function} ${r.status}`)).toEqual([
      "fn:app:react-username-password:auth.signUpWithUsernamePassword complete",
      "fn:app:react-username-password:auth.signInWithUsernamePassword complete",
      "fn:app:react-username-password:auth.refreshSession rotated",
      "fn:app:react-username-password:auth.refreshSession rotated",
      "fn:app:react-username-password:auth.refreshSession noSession",
      "fn:auth:sessions.deleteSessionTokens ok",
      "fn:app:react-username-password:auth.signInWithUsernamePassword error",
    ]);
    for (const r of runs)
      for (const s of r.steps)
        if (s.kind === "call")
          expect(world.index.part.has(s.target), s.target).toBe(true);
    expect(
      runs[0].steps
        .filter((s) => s.kind === "call")
        .map((s) => s.kind === "call" && s.target),
    ).toEqual([
      "fn:authUsername:public.getUserIdByUsername",
      "fn:auth:public._internal_dangerous_signUp",
      "fn:authUsername:public.setUsername",
      "fn:authPassword:public._internal_dangerous_setPassword",
    ]);
    expect(runs[4].tone).toBe("warn");
    expect(runs[6].tone).toBe("error");
  });

  test("marks what it derives", () => {
    // The recording links every write to its run here; the reuse deletes the session.
    expect(runs.flatMap((r) => r.writes).filter((w) => w.derived)).toEqual([]);
    expect(runs[4].writes.map((w) => `${w.op} ${w.table}`)).toEqual([
      "delete table:auth.sessions",
    ]);
    expect(runs[5].scheduledBy).toMatchObject({
      run: runs[4].id,
      derived: { rule: "scheduled-by-structure" },
    });
    // Refresh tokens travel: out with the response that inserted them, in with the request that redeemed them.
    expect(runs.map((r) => [r.carriesIn.length, r.carriesOut.length])).toEqual([
      [0, 1],
      [0, 1],
      [1, 1],
      [1, 1],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(runs[2].carriesIn[0].row).toBe(runs[1].carriesOut[0].row);
    expect(runs[3].carriesIn[0].row).toBe(runs[2].carriesOut[0].row);
    for (const r of runs)
      for (const c of [...r.carriesIn, ...r.carriesOut])
        expect(c.derived.note).toBeTruthy();
  });

  test("the refresh tokens of the session go through their states, then away", () => {
    const tl = world.timeline;
    const states = (t: number) =>
      (world.stateAt(t).tables.get(REFRESH) ?? [])
        .filter((r) => r.deletedAt === undefined)
        .map((r) => r.state);
    expect(states(tl.chapters[1].end)).toEqual(["issued", "issued"]);
    expect(states(tl.chapters[2].end)).toEqual([
      "issued",
      "redeemed",
      "issued",
    ]);
    expect(states(tl.chapters[3].end)).toEqual([
      "issued",
      "spent",
      "redeemed",
      "issued",
    ]);
    expect(states(tl.chapters[5].end)).toEqual(["issued"]);
    // The warning of the reuse shows over the function that logged it.
    const warn = tl.alerts[0];
    expect(warn.part).toBe("fn:auth:public.refresh");
    expect(world.stateAt(warn.start + 0.1).alerts).toHaveLength(1);
  });

  test("keeps the real durations next to a human-speed schedule", () => {
    for (const c of world.timeline.chapters) {
      expect(c.run.endedAt - c.run.startedAt).toBeLessThan(1000);
      expect(c.end - c.start).toBeGreaterThan(3);
    }
  });
});
