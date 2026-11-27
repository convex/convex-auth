/**
 * Groups of parts and what took part, on Convex Auth's saved page
 * recording (a sign-up with username and password, then more).
 */
import { describe, expect, test } from "vitest";
import { commonDir, dirOf } from "../layout/islands.ts";
import {
  buildTimeline,
  LOAD_SWEEP,
  STATE_PULSE,
  STEP_FADE,
  type Timeline,
} from "../model/schedule.ts";
import { takenPart } from "../model/takenPart.ts";
import { loadProject, PROJECTS } from "../project.ts";

const world = loadProject(PROJECTS["convex-auth"], "page");
const district = world.layout.islands.find((i) => i.clusters.length > 5)!;
const group = (id: string) => district.clusters.find((c) => c.id === id)!;

describe("groups", () => {
  test("directories", () => {
    expect(dirOf("methods/oauth/react")).toBe("methods/oauth");
    expect(dirOf("index")).toBe("");
    expect(commonDir(["browser", "react"])).toBe("");
    expect(
      commonDir(["methods/username-passkey", "methods/username-passkey/x"]),
    ).toBe("methods/username-passkey");
  });

  test("every part of the client district is in exactly one group", () => {
    const seen = district.clusters.flatMap((c) => c.members);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...district.members].sort());
  });

  test("an owner that holds no more specific one splits by directory", () => {
    const ids = district.clusters.map((c) => c.id).sort();
    expect(ids).toContain("region:browser/browser");
    expect(ids).toContain("region:browser/react");
    expect(ids).not.toContain("region:browser");
    expect(group("region:browser/browser").label).toBe("browser");
    expect(group("region:browser/browser").prefix).toBe("browser");
    // A method's modules stay one group, deeper directories included.
    const passkey = group("method:username-passkey");
    expect(passkey.label).toBe("username-passkey");
    expect(passkey.prefix).toBe("methods/username-passkey");
    expect(passkey.members).toContain(
      "module:methods/username-passkey/management/add",
    );
    // A module's hooks are in its group.
    expect(group("region:browser/react").members).toContain(
      "hook:react/index.useAuthActions",
    );
  });

  test("the project names groups the data names poorly", () => {
    expect(world.presentation.groups?.["region:browser/browser"]?.label).toBe(
      "session core",
    );
  });
});

describe("what took part", () => {
  const facts = takenPart(
    world.index,
    world.layout,
    world.timeline,
    world.presentation.focus,
  );
  const at = (id: string) => facts.groups.get(id)?.at ?? Infinity;

  test("the session core reports first, on load", () => {
    const firstLoad = Math.min(...world.timeline.loads.map((l) => l.at));
    expect(at("region:browser/browser")).toBeLessThan(
      Math.min(at("region:browser/react"), at("method:username-password")),
    );
    expect(at("region:browser/browser")).toBeGreaterThanOrEqual(firstLoad);
    expect(facts.groups.get("region:browser/browser")?.how).toBe("reported");
  });

  test("the sign-up's call names a function of the username-password method", () => {
    const e = facts.groups.get("method:username-password");
    expect(e?.how).toBe("called");
    expect(e?.part).toMatch(/:auth\.signUpWithUsernamePassword$/);
    const call = world.timeline.clientSteps.find(
      (s) => s.step === "signIn.call",
    );
    expect(e?.at).toBe(call?.start);
  });

  test("no other sign-in method took part", () => {
    const methods = district.clusters
      .map((c) => c.id)
      .filter((id) => id.startsWith("method:"));
    expect(methods.filter((id) => facts.groups.has(id))).toEqual([
      "method:username-password",
    ]);
  });

  test("the app is wired to the username-password method by its source", () => {
    expect([...facts.wired.keys()]).toEqual(["method:username-password"]);
    const link = facts.wired.get("method:username-password")!;
    expect(link.kind).toBe("usesMethod");
    expect(link.evidence.length).toBeGreaterThan(0);
  });

  test("a part counts from its first report, not before", () => {
    const first = world.timeline.clientSteps.find(
      (s) => s.part === "module:browser/storage",
    )!;
    expect(facts.parts.get("module:browser/storage")).toBe(first.start);
    expect(facts.parts.has("module:methods/username-passkey/client")).toBe(
      false,
    );
  });
});

describe("before any run", () => {
  // The page as it loads signed out: it reports steps and calls nothing.
  // In the saved recording that is what came before the sign-up's call.
  const before = world.recording.runs[0].before;
  const call = before.findIndex((it) => it.step === "signIn.call");
  const early = before.slice(0, call).filter((it) => it.step);
  const recording = { ...world.recording, runs: [], early };
  const timeline = buildTimeline(world.index, recording);

  test("the page's steps are placed, in order", () => {
    expect(early.length).toBeGreaterThan(0);
    expect(timeline.clientSteps.map((s) => s.step)).toEqual(
      early.map((it) => it.step),
    );
    const starts = timeline.clientSteps.map((s) => s.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  test("what reported on load has taken part", () => {
    const facts = takenPart(
      world.index,
      world.layout,
      timeline,
      world.presentation.focus,
    );
    expect(facts.groups.get("region:browser/browser")?.how).toBe("reported");
    expect(facts.groups.has("method:username-password")).toBe(false);
  });
});

/** Whether anything is still being drawn as happening at `t`. */
function happeningAt(tl: Timeline, t: number): string[] {
  return [
    ...tl.activations.filter((a) => a.end > t).map((a) => `lit ${a.node}`),
    ...tl.clientSteps
      .filter((c) => c.end + STEP_FADE > t)
      .map((c) => `halo ${c.part}`),
    ...tl.loads
      .filter((l) => l.at + LOAD_SWEEP > t)
      .map((l) => `sweep ${l.page}`),
    ...tl.movements.filter((m) => m.end > t).map((m) => `moving ${m.id}`),
    ...tl.states
      .filter((c) => c.at + STATE_PULSE > t)
      .map((c) => `pulse ${c.holder}`),
    ...tl.holdings
      .filter((h) => h.op === "drop" && h.at + STATE_PULSE > t)
      .map((h) => `pulse ${h.holder}`),
  ];
}

describe("the world opens at rest", () => {
  test("with only what the page did on load, nothing is happening at the end", () => {
    // A load that ends on its change of state (to signed out), as a live
    // one does: the last thing placed is the one with the longest effect.
    const before = world.recording.runs[0].before;
    const call = before.findIndex((it) => it.step === "signIn.call");
    const last = before
      .slice(0, call)
      .findLastIndex((it) => it.state !== undefined);
    expect(last).toBeGreaterThan(0);
    const tl = buildTimeline(world.index, {
      ...world.recording,
      runs: [],
      early: before.slice(0, last + 1),
    });
    expect(tl.loads.length).toBeGreaterThan(0);
    expect(happeningAt(tl, tl.duration)).toEqual([]);
  });

  test("nor at the end of the whole recording", () => {
    expect(happeningAt(world.timeline, world.timeline.duration)).toEqual([]);
  });
});
