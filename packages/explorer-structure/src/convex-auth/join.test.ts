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
    expect(ambiguous).toEqual([
      "module:browser/sessionManager signOut.revoke",
      "module:browser/sessionManager state",
      "server session.issued",
    ]);
  });
});
