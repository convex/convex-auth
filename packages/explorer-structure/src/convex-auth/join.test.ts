import { describe, expect, test } from "vitest";
import { structure } from "../index.ts";
import { stepOrigin, stepSites, type RecordedStep } from "./join.ts";

// Recordings of examples/react-username-password that the explorer world
// plays, read only: the step names and parts here must be the ones they carry.
const recordings = import.meta.glob<string>(
  "../../../explorer-world/projects/convex-auth/recording-*.ndjson",
  { query: "?raw", import: "default", eager: true },
);
const recordedSteps: RecordedStep[] = Object.values(recordings).flatMap(
  (text) =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { kind: string } & RecordedStep)
      .filter((line) => line.kind === "step"),
);

describe("joining a recorded step", () => {
  test("the recordings hold steps of both sides", () => {
    expect(recordedSteps.some((s) => s.runsIn === "browser")).toBe(true);
    expect(recordedSteps.some((s) => s.runsIn === undefined)).toBe(true);
  });

  test("every recorded step has a site", () => {
    const missing = recordedSteps.filter(
      (s) => stepOrigin(structure, s) === null,
    );
    expect(missing).toEqual([]);
  });

  test("a recorded step gives its module and its export", () => {
    expect(
      stepOrigin(structure, {
        runsIn: "browser",
        part: "module:browser/mutex",
        step: "lock.acquired",
      }),
    ).toMatchObject({
      part: "module:browser/sessionManager",
      export: "AuthClient",
      sites: [{ within: ["AuthClient", "fetchAccessToken"] }],
    });
    expect(
      stepOrigin(structure, {
        runsIn: "browser",
        part: "module:react/index",
        step: "signIn.call",
      }),
    ).toMatchObject({ part: "module:react/signInSteps", export: null });
    expect(stepOrigin(structure, { step: "refresh.result" })).toMatchObject({
      part: "methodFn:core.refreshSession",
      export: "setupConvexAuth",
    });
  });

  test("the steps that more than one site can report", () => {
    const ambiguous = [
      ...new Set(
        recordedSteps
          .filter((s) => stepSites(structure, s).length > 1)
          .map((s) => `${s.part ?? "server"} ${s.step}`),
      ),
    ].sort();
    // The SPA and the SSR branch of the constructor both report
    // `signOut.revoke` with `skipped: false` (the SPA one computes it).
    expect(ambiguous).toEqual(["module:browser/sessionManager signOut.revoke"]);
  });

  test("a literal the source writes narrows the sites", () => {
    const issued = (via: string) =>
      stepSites(structure, { step: "session.issued", detail: { via } }).map(
        (s) => s.within.at(-1),
      );
    expect(issued("signUp")).toEqual(["completeSignUp"]);
    expect(issued("signIn")).toEqual(["completeSignIn"]);
    const state = (detail: Record<string, unknown>) =>
      stepSites(structure, {
        runsIn: "browser",
        part: "module:browser/sessionManager",
        step: "state",
        detail,
      }).map((s) => s.within.at(-1));
    const base = {
      isLoading: false,
      isAuthenticated: true,
      tokenChanged: true,
    };
    expect(state(base)).toEqual(["#notify"]);
    expect(state({ ...base, tokenChanged: false, initial: true })).toEqual([
      "init",
    ]);
  });

  test("a site holds only literals, never a computed value", () => {
    const revoke = structure.steps.filter((s) => s.step === "signOut.revoke");
    expect(revoke.map((s) => s.detailLiterals)).toEqual([
      undefined,
      { skipped: false },
    ]);
  });
});
