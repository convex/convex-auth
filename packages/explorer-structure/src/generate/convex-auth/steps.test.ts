// @vitest-environment node
// The scans run the TypeScript compiler, which needs Node.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import ts from "typescript";
import { createProgram } from "../convex/program.ts";
import { scanHolds } from "./holds.ts";
import { scanStepSites, type StepReporter } from "./steps.ts";

const dir = mkdtempSync(join(tmpdir(), "steps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const files: Record<string, string> = {
  "report.ts": `export type Part = "module:a" | "module:b";
export function report(part: Part, step: string, detail: Record<string, unknown> = {}) {}
export function serverReport(step: string, detail: Record<string, unknown> = {}) {}
`,
  "a.ts": `import { report, serverReport, type Part } from "./report.ts";
const STEPS = "module:a";
const open = (): Record<string, unknown> => ({});
const known = () => ({ found: true });

export class Client {
  run(n: number) {
    report(STEPS, "run.start", { n, ...known() });
  }
  #inner = () => {
    report("module:b", "inner", { ...open(), x: 1 });
  };
}

function relay(part: Part, label: string) {
  report(part, "relay", { label });
}

export function viaA() { relay("module:a", "a"); }
export function viaB() { relay("module:b", "b"); }

export const server = {
  handler: async () => {
    serverReport("server.done");
  },
};
`,
  "storage.ts": `export class NamespacedStorage {
  get(key: string) { return key; }
  set(key: string, value: string) {}
  remove(key: string) {}
  key(key: string) { return key; }
}
export type SignInStorage = { get(key: string): string };
export const TOKEN_KEY = "__token";
`,
  "mutex.ts": `export async function runWithMutex<T>(name: string, fn: () => Promise<T>) { return fn(); }\n`,
  "holder.ts": `import { NamespacedStorage, TOKEN_KEY, type SignInStorage } from "./storage.ts";
import { runWithMutex } from "./mutex.ts";
const KEYS = { one: "__one", two: "__two" };

export class Holder {
  readonly #storage = new NamespacedStorage();
  readonly #lock: string;
  constructor(private readonly signIn: SignInStorage) {
    this.#lock = this.#storage.key(TOKEN_KEY);
  }
  async go(flow: "one" | "two", dynamic: string) {
    this.#storage.get(TOKEN_KEY);
    this.#storage.set(KEYS[flow], "v");
    this.#storage.remove(KEYS.one);
    this.signIn.get("flow");
    this.#storage.get(dynamic);
    await runWithMutex(this.#lock, async () => 1);
  }
}
`,
};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(dir, name), text);
}
const program = createProgram({
  root: dir,
  files: Object.keys(files).map((name) => join(dir, name)),
  types: [],
});
const checker = program.getTypeChecker();
const sourceFiles = Object.keys(files).map((name) =>
  program.getSourceFile(join(dir, name))!,
);
const location = (node: ts.Node) => {
  const file = node.getSourceFile();
  return {
    file: file.fileName.slice(dir.length + 1),
    line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
  };
};
const moduleOfFile = (fileName: string) =>
  `module:${fileName.slice(dir.length + 1).replace(/\.ts$/, "")}`;

const reporters: StepReporter[] = [
  {
    file: join(dir, "report.ts"),
    name: "report",
    runsIn: "browser",
    args: { part: 0, step: 1, detail: 2 },
  },
  {
    file: join(dir, "report.ts"),
    name: "serverReport",
    runsIn: "server",
    args: { step: 0, detail: 1 },
  },
];

describe("the step sites", () => {
  const sites = scanStepSites(reporters, {
    program,
    checker,
    files: sourceFiles,
    location,
    partAt: (node) => moduleOfFile(node.getSourceFile().fileName),
  });

  test("one site for each call, with its step, part, keys, and place", () => {
    expect(sites).toEqual([
      {
        step: "run.start",
        runsIn: "browser",
        location: { file: "a.ts", line: 8 },
        part: "module:a",
        export: "Client",
        within: ["Client", "run"],
        reportsAs: "module:a",
        detailKeys: ["n", "found"],
      },
      {
        step: "inner",
        runsIn: "browser",
        location: { file: "a.ts", line: 11 },
        part: "module:a",
        export: "Client",
        within: ["Client", "#inner"],
        reportsAs: "module:b",
        detailKeys: ["x"],
        detailOpen: ["open()"],
      },
      {
        step: "relay",
        runsIn: "browser",
        location: { file: "a.ts", line: 16 },
        part: "module:a",
        export: null,
        reachedFrom: ["viaA", "viaB"],
        within: ["relay"],
        reportsAsPassedIn: {
          parameter: "part",
          values: [
            { part: "module:a", location: { file: "a.ts", line: 19 } },
            { part: "module:b", location: { file: "a.ts", line: 20 } },
          ],
        },
        detailKeys: ["label"],
      },
      {
        step: "server.done",
        runsIn: "server",
        location: { file: "a.ts", line: 24 },
        part: "module:a",
        export: "server",
        within: ["server", "handler"],
        detailKeys: [],
      },
    ]);
  });

  test("a step name the source does not spell out stops the scan", () => {
    writeFileSync(
      join(dir, "bad.ts"),
      `import { report } from "./report.ts";\nexport function f(s: string) { report("module:a", s); }\n`,
    );
    const bad = createProgram({
      root: dir,
      files: [join(dir, "report.ts"), join(dir, "bad.ts")],
      types: [],
    });
    expect(() =>
      scanStepSites(reporters.slice(0, 1), {
        program: bad,
        checker: bad.getTypeChecker(),
        files: [bad.getSourceFile(join(dir, "bad.ts"))!],
        location,
        partAt: () => null,
      }),
    ).toThrow("bad.ts:2: the step's name is not spelled out in the source");
  });
});

describe("what a module holds", () => {
  const holds = scanHolds({
    program,
    checker,
    files: sourceFiles,
    location,
    storageFile: join(dir, "storage.ts"),
    mutexFile: join(dir, "mutex.ts"),
    moduleOfFile: (fileName) =>
      fileName.endsWith("holder.ts") ? "module:holder" : null,
  });

  test("the stored keys it spells out, the ones it does not, and its locks", () => {
    expect(holds).toEqual({
      "module:holder": {
        storage: [
          {
            key: "__one",
            store: "NamespacedStorage",
            ops: ["remove", "set"],
            evidence: [
              { file: "holder.ts", line: 13 },
              { file: "holder.ts", line: 14 },
            ],
          },
          {
            key: "__token",
            store: "NamespacedStorage",
            ops: ["get", "key"],
            evidence: [
              { file: "holder.ts", line: 9 },
              { file: "holder.ts", line: 12 },
            ],
          },
          {
            key: "__two",
            store: "NamespacedStorage",
            ops: ["set"],
            evidence: [{ file: "holder.ts", line: 13 }],
          },
          {
            key: "flow",
            store: "SignInStorage",
            ops: ["get"],
            evidence: [{ file: "holder.ts", line: 15 }],
          },
        ],
        unresolvedStorage: [
          {
            code: "this.#storage.get(dynamic)",
            location: { file: "holder.ts", line: 16 },
          },
        ],
        locks: [
          {
            storageKey: "__token",
            code: "this.#lock",
            location: { file: "holder.ts", line: 17 },
          },
        ],
      },
    });
  });
});
