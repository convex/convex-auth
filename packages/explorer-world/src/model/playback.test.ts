import { describe, expect, test } from "vitest";
import { DELETE_FADE, nextStop, previousStop } from "./playback.ts";
import { project } from "../project.ts";
import { createWorld } from "./world.ts";

// The tests play the Convex Auth slice; the engine itself knows no project.
const world = createWorld(project.structure, project.recording);
const SCHEDULER = project.structure.places.find(
  (p) => p.role === "scheduler",
)!.id;
const { timeline } = world;
const chapter = (title: string) => {
  const c = timeline.chapters.find((c) => c.execution.title === title);
  if (!c) throw new Error(`No chapter ${title}`);
  return c;
};
const tokens = (t: number) =>
  new Map(
    (world.stateAt(t).tables.get("auth:refreshTokens") ?? []).map((r) => [
      r.label,
      { state: r.state, deleted: r.deletedAt !== undefined },
    ]),
  );

describe("playback", () => {
  test("the chapters follow the recording in order", () => {
    expect(timeline.chapters.map((c) => c.execution.title)).toEqual([
      "Sign up",
      "Sign in",
      "Refresh with A",
      "Refresh with B",
      "Reuse of spent token A",
      "Scheduled cleanup",
      "Sign in, wrong password",
    ]);
    for (let i = 1; i < timeline.chapters.length; i++) {
      expect(timeline.chapters[i].start).toBeGreaterThanOrEqual(
        timeline.chapters[i - 1].end,
      );
    }
  });

  test("the world is empty before the first commit", () => {
    const state = world.stateAt(chapter("Sign up").commitAt - 0.01);
    expect([...state.tables.values()].flat()).toHaveLength(0);
    expect(state.holdings.get("browser") ?? []).toHaveLength(0);
  });

  test("the writes of a function run commit together", () => {
    const state = world.stateAt(chapter("Sign up").commitAt);
    const counts = Object.fromEntries(
      [...state.tables].map(([k, v]) => [k, v.length]),
    );
    expect(counts).toEqual({
      "app:users": 1,
      "auth:createdUserIds": 1,
      "auth:ttlConfig": 1,
      "auth:sessions": 1,
      "auth:refreshTokens": 1,
      "authUsername:usernames": 1,
      "authPassword:passwords": 1,
    });
  });

  test("the browser gets the tokens when the response arrives", () => {
    const signUp = chapter("Sign up");
    expect(
      world.stateAt(signUp.end - 0.01).holdings.get("browser") ?? [],
    ).toHaveLength(0);
    const held = world.stateAt(signUp.end).holdings.get("browser")!;
    expect(held.map((k) => k.label).sort()).toEqual(["R0", "access₀"]);
  });

  test("refresh tokens go issued, redeemed, spent, deleted", () => {
    expect(tokens(chapter("Sign in").commitAt).get("A")?.state).toBe("issued");
    expect(
      tokens(chapter("Refresh with A").commitAt - 0.01).get("A")?.state,
    ).toBe("issued");
    expect(tokens(chapter("Refresh with A").commitAt).get("A")?.state).toBe(
      "redeemed",
    );
    expect(tokens(chapter("Refresh with A").commitAt).get("B")?.state).toBe(
      "issued",
    );
    const afterB = tokens(chapter("Refresh with B").commitAt);
    expect(afterB.get("A")?.state).toBe("spent");
    expect(afterB.get("B")?.state).toBe("redeemed");
    expect(afterB.get("C")?.state).toBe("issued");
    const cleanup = chapter("Scheduled cleanup").commitAt;
    expect(tokens(cleanup).get("A")?.deleted).toBe(true);
    expect(tokens(cleanup + DELETE_FADE).size).toBe(1); // R0 of session 1 remains
  });

  test("the browser's refresh token is replaced on each rotation", () => {
    const held = (t: number) =>
      (world.stateAt(t).holdings.get("browser") ?? [])
        .filter((k) => k.kind === "refresh")
        .map((k) => k.label);
    expect(held(chapter("Refresh with A").end)).toEqual(["B"]);
    expect(held(chapter("Refresh with B").end)).toEqual(["C"]);
  });

  test("the reuse of A revokes the session and schedules the cleanup", () => {
    const reuse = chapter("Reuse of spent token A");
    const before = world.stateAt(reuse.commitAt - 0.01);
    expect(
      before.tables.get("auth:sessions")!.find((r) => r.id === "s2")?.deletedAt,
    ).toBeUndefined();
    expect(before.alerts).toHaveLength(1);
    expect(before.holdings.get("elsewhere")?.map((k) => k.label)).toEqual([
      "A",
    ]);
    const after = world.stateAt(reuse.commitAt);
    expect(
      after.tables.get("auth:sessions")!.find((r) => r.id === "s2")?.deletedAt,
    ).toBe(reuse.commitAt);
    expect(after.travellers.some((t) => t.movement.to === SCHEDULER)).toBe(
      true,
    );
    expect(world.stateAt(reuse.end).holdings.get("elsewhere")).toEqual([]);
  });

  test("the failed sign-in writes only the rate limit", () => {
    const failed = chapter("Sign in, wrong password");
    const before = world.stateAt(failed.commitAt - 0.01);
    const after = world.stateAt(failed.commitAt);
    const limit = after.tables.get("authPassword/rateLimiter:rateLimits")!;
    expect(limit).toHaveLength(1);
    expect(limit[0].changedAt).toBe(failed.commitAt);
    expect(after.tables.get("auth:sessions")!.length).toBe(
      before.tables.get("auth:sessions")!.length,
    );
    expect(world.stateAt(failed.end).beat?.tone).toBe("error");
  });

  test("travellers move from 0 to 1 over their movement", () => {
    const m = timeline.movements[0];
    const mid = world
      .stateAt((m.start + m.end) / 2)
      .travellers.find((t) => t.movement.id === m.id);
    expect(mid?.progress).toBeCloseTo(0.5);
    expect(
      world.stateAt(m.end).travellers.find((t) => t.movement.id === m.id),
    ).toBeUndefined();
  });

  test("a function is active while it runs", () => {
    const signIn = chapter("Sign in");
    const verify = timeline.activations.find(
      (a) =>
        a.execution === signIn.execution.id &&
        a.node === "authPassword:public:verifyPassword",
    )!;
    expect(world.stateAt(verify.start - 0.01).active.has(verify.node)).toBe(
      false,
    );
    expect(world.stateAt(verify.start).active.has(verify.node)).toBe(true);
    expect(
      world
        .stateAt(verify.start)
        .active.has("app:auth:signInWithUsernamePassword"),
    ).toBe(true);
  });

  test("time is clamped and stepping lands on beats", () => {
    expect(world.stateAt(-5).time).toBe(0);
    expect(world.stateAt(1e9).time).toBe(timeline.duration);
    const first = nextStop(timeline, 0);
    expect(timeline.beats.some((b) => b.start === first)).toBe(true);
    expect(previousStop(timeline, nextStop(timeline, first))).toBe(first);
    expect(nextStop(timeline, timeline.duration)).toBe(timeline.duration);
    expect(previousStop(timeline, 0)).toBe(0);
  });

  test("scrubbing back gives the same state as playing to that time", () => {
    const t = chapter("Refresh with B").commitAt + 0.3;
    const forward = tokens(t);
    world.stateAt(timeline.duration);
    expect(tokens(t)).toEqual(forward);
    expect(
      world
        .stateAt(t)
        .tables.get("auth:refreshTokens")!
        .map((r) => r.state),
    ).toEqual(["issued", "spent", "redeemed", "issued"]);
  });
});
