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

  /** What the page's storage keys hold at a time. */
  const held = (t: number) =>
    [...world.stateAt(t).holdings]
      .filter(([holder]) => holder.startsWith("storageKey:"))
      .flatMap(([, cargo]) => cargo);
  test("the page's storage keys hold what its storage holds", () => {
    const end = held(world.timeline.duration);
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
    expect(held(wrong.end)).toEqual([]);
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

describe("the client library in the browser", () => {
  test("a sign-in call leaves from the module that reported it, matched by bracket", () => {
    const signUp = runs.find((r) =>
      r.function.endsWith("signUpWithUsernamePassword"),
    )!;
    expect(signUp.sender?.part).toBe("module:react/index");
    expect(signUp.sender?.derived.rule).toBe("sender-by-bracket");
    expect(signUp.via).toBe("exit:socket");
    // Both sign-ins too, by the page's own order of events.
    for (const r of runs.filter((r) =>
      r.function.endsWith("signInWithUsernamePassword"),
    ))
      expect(r.sender?.part).toBe("module:react/index");
    const legs = world.timeline.movements.filter((m) => m.run === signUp.id);
    expect(legs[0]).toMatchObject({
      from: "module:react/index",
      to: "exit:socket",
    });
    // A run no sign-in call brackets leaves from the page.
    const refresh = runs.find((r) => r.function.endsWith("refreshSession"))!;
    expect(refresh.sender).toBeUndefined();
    expect(refresh.via).toBe("exit:http");
  });

  test("every step the page reported lights its module, and a storage step its key", () => {
    const steps = runs
      .flatMap((r) => [...r.before, ...r.after])
      .filter((i) => i.kind === "step");
    expect(steps.length).toBe(world.recording.events["step (page)"].seen);
    for (const s of steps) {
      expect(world.layout.parts.has(s.part), s.part).toBe(true);
      expect(s.lights?.[0]).toBe(s.part);
      if (s.step?.startsWith("storage."))
        expect(s.lights?.[1]).toMatch(/^storageKey:/);
    }
  });

  test("each sign-in call is reported before its request leaves, and returns after its response", () => {
    for (const run of runs.filter((r) => r.sender)) {
      const legs = world.timeline.movements.filter((m) => m.run === run.id);
      const leaves = legs.find((m) => m.kind === "request")!.start;
      const back = legs.filter((m) => m.kind === "response").at(-1)!.end;
      const steps = world.timeline.clientSteps.filter(
        (s) => s.part === run.sender!.part,
      );
      const call = steps
        .filter((s) => s.step === "signIn.call" && s.start <= leaves)
        .at(-1);
      const ret = steps.find(
        (s) => s.step === "signIn.return" && s.start >= back,
      );
      expect(call, run.function).toBeDefined();
      expect(ret, run.function).toBeDefined();
      // Its own call: no sign-in returned between it and the request.
      expect(
        steps.some(
          (s) =>
            s.step === "signIn.return" &&
            s.start > call!.start &&
            s.start < leaves,
        ),
        run.function,
      ).toBe(false);
    }
  });

  test("the page's sign-in state follows what the client library reported", () => {
    const states = world.timeline.states.map((s) => s.state);
    expect(states).toContain("signingIn");
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("signedIn");
  });
});
