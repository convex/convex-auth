import { describe, expect, test } from "vitest";
import { eventsFromLogEntry, parseStepReport, type LogEntry } from "./logs.ts";
import { logEntries } from "./testFixtures.ts";

describe("eventsFromLogEntry", () => {
  test("a sign-up gives its run and its step reports in order", () => {
    const { run, lines } = eventsFromLogEntry(logEntries[0]);
    expect(run).toMatchObject({
      kind: "run",
      udfType: "Mutation",
      componentPath: "",
      identifier: "auth:signUpWithUsernamePassword",
      caller: "HttpApi",
      ok: true,
      error: null,
      writeCount: 6,
    });
    expect(run!.time).toBe(logEntries[0].executionTimestamp! * 1000);
    expect(run!.endTime).toBe(logEntries[0].timestamp * 1000);
    expect(lines.map((line) => line.kind === "step" && line.step)).toEqual([
      "method.start",
      "call",
      "return",
      "call",
      "return",
      "session.issued",
      "call",
      "return",
      "call",
      "return",
      "method.result",
    ]);
    expect(lines[0]).toEqual({
      kind: "step",
      id: `${run!.id}#0`,
      time: (logEntries[0].logLines[0] as { timestamp: number }).timestamp,
      runId: run!.id,
      v: 1,
      step: "method.start",
      detail: { method: "usernamePassword", authenticated: false },
    });
  });

  test("a line that is not a step report is a log line of its component", () => {
    const reuse = logEntries.find((entry) =>
      JSON.stringify(entry.logLines).includes("Spent refresh token"),
    )!;
    const { lines } = eventsFromLogEntry(reuse);
    const warning = lines.find((line) => line.kind === "log");
    expect(warning).toMatchObject({
      kind: "log",
      level: "WARN",
      componentPath: "auth",
      udfPath: "public.js:refresh",
      isTruncated: false,
    });
    expect(warning!.kind === "log" && warning!.message).toMatch(
      /^Spent refresh token used/,
    );
  });

  test("a function of a component that the scheduler ran", () => {
    const scheduled = logEntries.filter(
      (entry) => entry.identifier === "sessions:deleteSessionTokens",
    );
    expect(scheduled).toHaveLength(2);
    expect(eventsFromLogEntry(scheduled[0]).run).toMatchObject({
      componentPath: "auth",
      caller: "Scheduler",
    });
  });

  test("a progress entry gives lines and no run, numbered from firstLine", () => {
    const progress: LogEntry = {
      kind: "Progress",
      udfType: "Action",
      identifier: "actions:slow",
      timestamp: 1795730000,
      requestId: "r",
      executionId: "e",
      logLines: [
        { messages: ["'halfway'"], level: "INFO", timestamp: 1795730000001 },
      ],
    };
    expect(eventsFromLogEntry(progress, 3)).toEqual({
      run: null,
      lines: [
        {
          kind: "log",
          id: "e#3",
          time: 1795730000001,
          runId: "e",
          level: "INFO",
          componentPath: "",
          udfPath: "actions:slow",
          message: "halfway",
          isTruncated: false,
        },
      ],
    });
  });

  test("a failed run carries its error, with secrets scrubbed", () => {
    const { run } = eventsFromLogEntry({
      ...logEntries[0],
      error:
        "Uncaught Error: bad token eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln",
    });
    expect(run).toMatchObject({
      ok: false,
      error: "Uncaught Error: bad token [redacted]",
    });
  });
});

describe("parseStepReport", () => {
  test("keeps a step that it does not know, and its fields", () => {
    expect(
      parseStepReport(
        '[convex-auth:step] {"v":1,"step":"totp.checked","ok":true}',
      ),
    ).toEqual({ v: 1, step: "totp.checked", detail: { ok: true } });
  });

  test("accepts a newer or a missing version", () => {
    expect(
      parseStepReport('[convex-auth:step] {"v":7,"step":"call","extra":[1]}'),
    ).toEqual({ v: 7, step: "call", detail: { extra: [1] } });
    expect(parseStepReport('[convex-auth:step] {"step":"call"}')).toEqual({
      v: null,
      step: "call",
      detail: {},
    });
  });

  test("returns null for a line that is not a report", () => {
    expect(parseStepReport("hello")).toBeNull();
    expect(parseStepReport("[convex-auth:step] {not json")).toBeNull();
    expect(parseStepReport('[convex-auth:step] {"v":1}')).toBeNull();
    expect(parseStepReport("[convex-auth:step] [1]")).toBeNull();
  });
});
