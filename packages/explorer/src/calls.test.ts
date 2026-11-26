import { describe, expect, test } from "vitest";
import { linkCall, WINDOW_TOLERANCE_MS } from "./calls.ts";
import type { CallEvent, RunEvent } from "./events.ts";

const run = (overrides: Partial<RunEvent>): RunEvent => ({
  kind: "run",
  id: "r",
  time: 1000,
  endTime: 1010,
  udfType: "Mutation",
  componentPath: "",
  identifier: "auth:signIn",
  caller: "SyncWorker",
  requestId: "x",
  parentExecutionId: null,
  ok: true,
  error: null,
  cachedResult: false,
  writeCount: 1,
  readCount: 1,
  identityType: null,
  ...overrides,
});

const call = (overrides: Partial<CallEvent>): CallEvent => ({
  kind: "call",
  id: "c",
  time: 999,
  endTime: 1012,
  pageId: "p1",
  transport: "socket",
  udfType: "Mutation",
  identifier: "auth:signIn",
  requestEventId: "p1#1",
  responseEventId: "p1#2",
  ok: true,
  commitTs: null,
  logLineCount: 2,
  runId: null,
  link: null,
  unlinked: "not linked yet",
  candidateRunIds: [],
  ...overrides,
});

const context = (runs: RunEvent[], skew = 0) => ({
  runs,
  lineCounts: new Map(runs.map((r) => [r.id, 2])),
  used: new Set<string>(),
  skew,
});

describe("linkCall", () => {
  test("links a mutation by its commit time, whatever the clocks", () => {
    const runs = [
      run({ id: "a", time: 1000, endTime: 1010 }),
      run({ id: "b", time: 1020, endTime: 1030 }),
    ];
    // The page's clock is a minute off; the commit time is the deployment's.
    const linked = linkCall(
      call({ time: 61_000, endTime: 61_040, commitTs: "1025000000" }),
      context(runs),
    );
    expect(linked).toMatchObject({
      runId: "b",
      link: "commitTs",
      unlinked: null,
    });
  });

  test("links an HTTP call by its window, after the skew", () => {
    const refresh = run({
      id: "a",
      identifier: "auth:refresh",
      caller: "HttpApi",
      time: 61_001,
      endTime: 61_009,
    });
    const linked = linkCall(
      call({
        transport: "http",
        identifier: "auth:refresh",
        time: 1000,
        endTime: 1010,
      }),
      context([refresh], 60_000),
    );
    expect(linked).toMatchObject({ runId: "a", link: "window" });
  });

  test("does not link a run of another caller or outside the window", () => {
    const runs = [
      run({ id: "http", caller: "HttpApi" }),
      run({ id: "late", time: 1100, endTime: 1100 + WINDOW_TOLERANCE_MS }),
    ];
    expect(linkCall(call({}), context(runs))).toMatchObject({
      runId: null,
      unlinked: "no run of auth:signIn between the call and its result",
    });
    expect(
      linkCall(call({ identifier: "auth:other" }), context(runs)).unlinked,
    ).toBe("no run of auth:other from the socket in the logs");
  });

  test("checks only the end of a query answered from the cache", () => {
    const cached = run({
      id: "q",
      udfType: "Query",
      identifier: "auth:isAuthenticated",
      time: 10,
      endTime: 1005,
      cachedResult: true,
    });
    expect(
      linkCall(
        call({ udfType: "Query", identifier: "auth:isAuthenticated" }),
        context([cached]),
      ),
    ).toMatchObject({ runId: "q", link: "window" });
  });

  test("lists the candidates when several runs fit equally", () => {
    const runs = [run({ id: "a" }), run({ id: "b", time: 1001 })];
    expect(linkCall(call({}), context(runs))).toMatchObject({
      runId: null,
      unlinked: "2 runs of auth:signIn between the call and its result",
      candidateRunIds: ["a", "b"],
    });
  });

  test("breaks a tie by the number of log lines", () => {
    const runs = [run({ id: "a" }), run({ id: "b", time: 1001 })];
    const ctx = context(runs);
    ctx.lineCounts.set("b", 5);
    expect(linkCall(call({ logLineCount: 5 }), ctx)).toMatchObject({
      runId: "b",
    });
  });

  test("does not link a run twice", () => {
    const ctx = context([run({ id: "a" })]);
    ctx.used.add("a");
    expect(linkCall(call({}), ctx).runId).toBe(null);
  });
});
