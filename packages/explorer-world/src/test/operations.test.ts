import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { BRACKET } from "../model/operations.ts";
import { prepareProject, PROJECTS, worldFromEvents } from "../project.ts";

// sign up, sign out, sign in, pressed in the live example.
const events = parseNdjson(
  readFileSync(
    new URL("./fixtures/live-actions.ndjson", import.meta.url),
    "utf8",
  ),
);
const { world } = worldFromEvents(
  prepareProject(PROJECTS["convex-auth"]),
  events,
  "live",
);
const { ops, chapters } = world.timeline;
const runOf = (id?: string) => chapters.find((c) => c.run.id === id)?.run;

describe("operations of the client", () => {
  test("every step that names an operation is in exactly one, keyed by page and document load", () => {
    const steps = events.filter(
      (e) =>
        e.kind === "step" &&
        e.from === "page" &&
        (e.detail as { op?: number } | undefined)?.op != null,
    );
    expect(steps.length).toBeGreaterThan(20);
    // The page loads again on sign up: its op 1 is not the first load's op 1.
    const firsts = ops.filter((o) => o.id.endsWith("|1"));
    expect(new Set(firsts.map((o) => o.id)).size).toBe(firsts.length);
    expect(firsts.length).toBeGreaterThanOrEqual(2);
    expect(ops.every((o) => /\|load\d+\|\d+$/.test(o.id))).toBe(true);
  });

  test("a sign-in goes out with the one call in its bracket and back to its keys", () => {
    const signIns = ops.filter((o) => o.kind === "signIn");
    expect(signIns).toHaveLength(2);
    for (const o of signIns) {
      const run = runOf(o.run);
      expect(run?.function).toMatch(
        /signUpWithUsernamePassword|signInWithUsernamePassword/,
      );
      expect(o.matched).toBe(BRACKET);
      const steps = o.points.map((p) => p.step);
      // Out to the WebSocket and back, before the session is set and stored.
      const out = steps.indexOf("out");
      expect(steps.indexOf("signIn.call")).toBeLessThan(out);
      expect(o.points[out].anchor).toBe(run!.via);
      expect(steps.indexOf("session.set")).toBeGreaterThan(out);
      const keys = o.points.filter((p) => p.anchor.startsWith("storageKey:"));
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys[0].at).toBeGreaterThan(o.points[out].at);
    }
  });

  test("a forced token fetch is matched to its refresh call", () => {
    const fetches = ops.filter(
      (o) =>
        o.kind === "tokenFetch" &&
        o.points.some((p) => p.step === "refresh.start"),
    );
    const matched = fetches.filter((o) => o.run);
    expect(matched.length).toBeGreaterThan(0);
    for (const o of matched)
      expect(runOf(o.run)?.function).toMatch(/refreshSession/);
  });

  test("an operation's path is a function of time", () => {
    for (const o of ops)
      for (let i = 1; i < o.points.length; i++)
        expect(o.points[i].at).toBeGreaterThan(o.points[i - 1].at);
  });
});
