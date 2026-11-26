import { describe, expect, test } from "vitest";
import { joinRecording } from "./join.ts";
import { structure } from "./index.ts";

// A recording of examples/react-username-password, made by the recorder
// (packages/explorer). Read only.
const fixtures = import.meta.glob<string>("../../explorer/src/fixtures/*", {
  query: "?raw",
  import: "default",
  eager: true,
});
const fixture = (name: string) => {
  const entry = Object.entries(fixtures).find(([path]) => path.endsWith(name));
  if (entry === undefined) {
    throw new Error(`No fixture ${name}`);
  }
  return entry[1].split("\n").filter((line) => line.trim() !== "");
};

type LogEntry = {
  componentPath: string | null;
  identifier: string;
  logLines: { messages: string[] }[];
};
const runs = fixture("logs.jsonl").map((line) => JSON.parse(line) as LogEntry);

/** The call targets of the step reports in the log lines. */
const callTargets = [
  ...new Set(
    runs.flatMap((run) =>
      run.logLines.flatMap((line) =>
        line.messages.flatMap((message) => {
          const match = /\[explorer:step\] (\{.*\})'?$/.exec(message);
          if (match === null) {
            return [];
          }
          const step = JSON.parse(match[1]!) as { target?: string };
          return step.target === undefined ? [] : [step.target];
        }),
      ),
    ),
  ),
].sort();

type Document = { component: string; table: string };
const tables = [
  ...new Map(
    fixture("sync-pages.ndjson")
      .map(
        (line) =>
          JSON.parse(line) as { values?: Document[]; truncates?: Document[] },
      )
      .flatMap((page) => [...(page.values ?? []), ...(page.truncates ?? [])])
      .map((d) => [
        `${d.component}|${d.table}`,
        { component: d.component, table: d.table },
      ]),
  ).values(),
];

const join = joinRecording(structure, "react-username-password");

describe("the join of a recording of react-username-password", () => {
  test("maps every run to its function", () => {
    const mapped = [
      ...new Set(
        runs.map(
          (r) => `${r.componentPath ?? ""} ${r.identifier} → ${join.run(r)}`,
        ),
      ),
    ].sort();
    expect(mapped).toEqual([
      " auth:refreshSession → fn:app:react-username-password:auth.refreshSession",
      " auth:signInWithUsernamePassword → fn:app:react-username-password:auth.signInWithUsernamePassword",
      " auth:signOut → fn:app:react-username-password:auth.signOut",
      " auth:signUpWithUsernamePassword → fn:app:react-username-password:auth.signUpWithUsernamePassword",
      "auth sessions:deleteSessionTokens → fn:auth:sessions.deleteSessionTokens",
    ]);
  });

  test("maps every call target of the step reports", () => {
    expect(callTargets.length).toBeGreaterThan(0);
    expect(
      Object.fromEntries(callTargets.map((t) => [t, join.callTarget(t)])),
    ).toEqual({
      "auth/public/_internal_dangerous_signIn":
        "fn:auth:public._internal_dangerous_signIn",
      "auth/public/_internal_dangerous_signUp":
        "fn:auth:public._internal_dangerous_signUp",
      "auth/public/refresh": "fn:auth:public.refresh",
      "auth/public/signOut": "fn:auth:public.signOut",
      "authPassword/public/_internal_dangerous_setPassword":
        "fn:authPassword:public._internal_dangerous_setPassword",
      "authPassword/public/verifyPassword":
        "fn:authPassword:public.verifyPassword",
      "authUsername/public/getUserIdByUsername":
        "fn:authUsername:public.getUserIdByUsername",
      "authUsername/public/setUsername": "fn:authUsername:public.setUsername",
    });
  });

  test("maps every table the recording shows, the rate limiter's included", () => {
    expect(
      Object.fromEntries(
        tables.map((t) => [`${t.component}|${t.table}`, join.table(t)]),
      ),
    ).toEqual({
      "|users": "table:app:react-username-password.users",
      "auth|createdUserIds": "table:auth.createdUserIds",
      "auth|refreshTokens": "table:auth.refreshTokens",
      "auth|sessions": "table:auth.sessions",
      "auth|ttlConfig": "table:auth.ttlConfig",
      "authPassword|passwords": "table:authPassword.passwords",
      "authPassword/rateLimiter|rateLimits":
        "table:authPassword/rateLimiter.rateLimits",
      "authUsername|usernames": "table:authUsername.usernames",
    });
  });

  test("an app function leads to the method's definition", () => {
    const run = join.run({
      componentPath: "",
      identifier: "auth:signInWithUsernamePassword",
    });
    expect(
      structure.dependencies.find(
        (d) => d.kind === "definedBy" && d.from === run,
      )?.to,
    ).toBe("methodFn:username-password.signInWithUsernamePassword");
  });

  test("names nothing it cannot find", () => {
    expect(
      join.run({ componentPath: "", identifier: "auth:noSuchFunction" }),
    ).toBeNull();
    expect(join.callTarget("noSuchComponent/public/x")).toBeNull();
    expect(join.table({ component: "auth", table: "noSuchTable" })).toBeNull();
    expect(join.component("authPassword/rateLimiter")).toBe(
      "component:authPassword/rateLimiter",
    );
  });
});
