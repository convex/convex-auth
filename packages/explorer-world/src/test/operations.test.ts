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

  test("a sign-in carries out the blanked password and back two tokens, each put down on the key that took it", () => {
    const keyOf = (secret: string) =>
      events.find(
        (e) =>
          e.kind === "storage" &&
          (e.value as { $secret?: string } | null)?.$secret === secret,
      )?.key as string | undefined;
    for (const o of ops.filter((x) => x.kind === "signIn")) {
      const out = o.loads.filter((l) => l.dir === "out");
      const back = o.loads.filter((l) => l.dir === "back");
      // The recorder blanks the password; it does not label it.
      expect(out.map((l) => l.load)).toEqual([
        { kind: "blanked", field: "password" },
      ]);
      expect(back.map((l) => l.load.kind)).toEqual(["secret", "secret"]);
      const via = o.points.find((p) => p.step === "out")!;
      for (const l of out) expect(l.to).toBe(via.at);
      for (const l of back) {
        if (l.load.kind !== "secret") continue;
        expect(l.from).toBeGreaterThan(via.at);
        // Put down where the storage event with its label says, when the
        // body is there, and resting there until the key shows it.
        expect(l.at).toBe(`storageKey:${keyOf(l.load.secret)}`);
        expect(o.points.some((p) => p.anchor === l.at && p.at === l.to)).toBe(
          true,
        );
        expect(l.held).toBeGreaterThanOrEqual(l.to - 1e-9);
      }
    }
  });

  test("nothing an operation carries is a value: labels and field names only", () => {
    const loads = ops.flatMap((o) => o.loads.map((l) => l.load));
    expect(loads.length).toBeGreaterThan(0);
    for (const l of loads) {
      expect(Object.keys(l).sort()).toEqual(
        l.kind === "blanked"
          ? ["field", "kind"]
          : ["cargo", "field", "kind", "secret", "type"].filter(
              (k) => k !== "cargo" || "cargo" in l,
            ),
      );
      if (l.kind === "secret") expect(l.secret).toMatch(/^s\d+$/);
    }
  });

  test("a token fetch carries out the refresh token it read from its key, when the key held it then", () => {
    const fetches = ops.filter((o) => o.kind === "tokenFetch" && o.run);
    expect(fetches.length).toBeGreaterThan(0);
    for (const o of fetches) {
      const out = o.loads.filter((l) => l.dir === "out");
      expect(out).toHaveLength(1);
      expect(out[0].load).toMatchObject({
        kind: "secret",
        field: "refreshToken",
      });
      if (out[0].at) {
        expect(out[0].at).toMatch(/RefreshToken/);
        expect(
          o.points.some((p) => p.anchor === out[0].at && p.at === out[0].from),
        ).toBe(true);
      }
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

  test("a sign-out goes out with the one call in its bracket, then removes its keys", () => {
    const signOuts = ops.filter((o) => o.kind === "signOut");
    expect(signOuts).toHaveLength(1);
    const [o] = signOuts;
    expect(o.matched).toBe(BRACKET);
    expect(runOf(o.run)?.type).not.toBe("Query");
    const steps = o.points.map((p) => p.step);
    const out = steps.indexOf("out");
    expect(out).toBeGreaterThan(steps.indexOf("signOut.start"));
    expect(steps.indexOf("storage.remove")).toBeGreaterThan(out);
  });

  test("the brackets come from the project's presentation; without them no call is matched", () => {
    const project = prepareProject(PROJECTS["convex-auth"]);
    const none = worldFromEvents(
      { ...project, presentation: { ...project.presentation, brackets: [] } },
      events,
      "live",
    ).world.timeline.ops;
    expect(none.some((o) => o.run)).toBe(false);
  });

  test("an operation's path is a function of time", () => {
    for (const o of ops)
      for (let i = 1; i < o.points.length; i++)
        expect(o.points[i].at).toBeGreaterThan(o.points[i - 1].at);
  });
});
