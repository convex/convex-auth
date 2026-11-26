/**
 * Convex Auth with its page: a browser driven through the
 * react-username-password scenario. Tokens are followed from data alone: the
 * message that carried each one, the storage that held it, and its row.
 */
import { describe, expect, test } from "vitest";
import { loadProject, PROJECTS } from "../project.ts";

const world = loadProject(PROJECTS["convex-auth"], "page");
const { runs, events, unplaced } = world.recording;
const PAGE = "page:p1";

describe("the recording of the page", () => {
  test("plays every event of the kinds it reads, and says why the rest do not", () => {
    for (const kind of [
      "run",
      "step",
      "write",
      "call",
      "secret",
      "secretLink",
      "storage",
      "input",
      "scenario",
      "page",
    ])
      expect(events[kind].played, kind).toBe(events[kind].seen);
    // Only messages and requests that no call refers to stay unplayed.
    expect(unplaced.map((u) => u.what.replace(/\d+/g, "N"))).toEqual([
      'N of N "http" events',
      'N of N "socket" events',
    ]);
  });

  test("the page calls the runs it called, and stands in the browser", () => {
    expect(world.layout.parts.get(PAGE)?.island).toBe("region:browser");
    const fromPage = runs
      .filter((r) => r.caller === PAGE)
      .map((r) => r.function.split(".").pop());
    expect(fromPage).toContain("signUpWithUsernamePassword");
    expect(fromPage).toContain("signOut");
    expect(fromPage.filter((f) => f === "refreshSession").length).toBe(4);
  });

  test("refresh tokens travel from data: each refresh presents the one the last response gave", () => {
    const withTokens = runs.filter(
      (r) => r.carriesIn.length || r.carriesOut.length,
    );
    for (const r of withTokens)
      for (const c of [...r.carriesIn, ...r.carriesOut])
        expect(c.derived).toBeUndefined();
    const refreshOut = (r: (typeof runs)[number]) =>
      r.carriesOut.find((c) => c.table === "table:auth.refreshTokens");
    let last: string | undefined;
    for (const r of withTokens) {
      const presented = r.carriesIn.find(
        (c) => c.table === "table:auth.refreshTokens",
      );
      if (presented && last) expect(presented.row).toBe(last);
      last = refreshOut(r)?.row ?? last;
    }
    // Each one is a row of the table, and it goes through its states.
    const rows = new Set(
      runs.flatMap((r) =>
        r.writes
          .filter((w) => w.table === "table:auth.refreshTokens")
          .map((w) => w.row),
      ),
    );
    for (const r of withTokens)
      for (const c of r.carriesOut.filter(
        (x) => x.table === "table:auth.refreshTokens",
      ))
        expect(rows.has(c.row)).toBe(true);
  });

  test("the page holds what its storage holds", () => {
    const end = world.stateAt(world.timeline.duration).holdings.get(PAGE) ?? [];
    expect(end.map((c) => c.label.replace(/ s\d+$/, "")).sort()).toEqual([
      "access token",
      "refresh token",
    ]);
    // After sign-out, before the next sign-in, it holds nothing.
    const signOut = world.timeline.chapters.find((c) =>
      c.title.startsWith("signOut"),
    )!;
    const wrong = world.timeline.chapters.find(
      (c) => c.section === "sign in with a wrong password",
    )!;
    expect(world.stateAt(wrong.end).holdings.get(PAGE) ?? []).toEqual([]);
    expect(signOut.section).toBe("sign out");
  });

  test("calls the recorder could not link stay unlinked, with the runs they may be", () => {
    const unlinked = runs
      .flatMap((r) => [...r.before, ...r.after])
      .filter((i) => i.kind === "call");
    // One run can answer two calls (a query result the page reuses), so
    // the linked calls are at least the runs the page called.
    expect(unlinked.length).toBeGreaterThan(0);
    expect(unlinked.length).toBeLessThanOrEqual(
      events.call.seen - runs.filter((r) => r.caller === PAGE).length,
    );
    for (const i of unlinked) expect(i.text).toContain("not linked");
  });
});
