// @vitest-environment node
// The reader runs the TypeScript compiler, which needs Node.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import ts from "typescript";
import {
  docText,
  firstParagraph,
  firstSentence,
  readModuleInside,
} from "./inside.ts";
import { createProgram } from "./program.ts";

const dir = mkdtempSync(join(tmpdir(), "inside-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function program(files: Record<string, string>): ts.Program {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return createProgram({
    root: dir,
    files: Object.keys(files).map((name) => join(dir, name)),
    types: [],
  });
}

const inside = (p: ts.Program, name: string, hooks: string[] = []) => {
  const file = p.getSourceFile(join(dir, name))!;
  return readModuleInside(file, {
    checker: p.getTypeChecker(),
    path: (absolute) => absolute.slice(dir.length + 1),
    moduleOfFile: (fileName) =>
      fileName === join(dir, "lib.ts") ? "module:lib" : null,
    partOf: (node) => {
      const name =
        ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
          ? node.name?.getText()
          : undefined;
      return name !== undefined && hooks.includes(name)
        ? `hook:main.${name}`
        : null;
    },
  });
};

describe("doc text", () => {
  test("drops the delimiters, the stars, and the tags, and unwraps links", () => {
    expect(
      docText(
        "/**\n * Uses {@link Foo} and {@link Bar | the bar}.\n *\n * More.\n * @module\n */",
      ),
    ).toBe("Uses Foo and the bar.\n\nMore.");
    expect(docText("/** @internal */")).toBe("");
  });

  test("the first sentence skips abbreviations and code", () => {
    expect(firstSentence("Keys, e.g. `a.b`. Then more.")).toBe(
      "Keys, e.g. `a.b`.",
    );
    expect(firstSentence("Ends `x. y` here. Next.")).toBe("Ends `x. y` here.");
    expect(firstSentence("No end")).toBe("No end");
  });

  test("the first paragraph joins its lines", () => {
    expect(firstParagraph("One\ntwo.\n\nThree.")).toBe("One two.");
    expect(firstParagraph("")).toBeNull();
  });
});

describe("a module's inside", () => {
  const p = program({
    "lib.ts": `/** Shared code. */
import { x } from "./other.ts";
/** The answer. It is 42. */
export const ANSWER = 42;
export function helper(): number { return x; }
`,
    "other.ts": `export const x = 1;\n`,
    "main.ts": `/**
 * The main module. It does
 * several things.
 *
 * Second paragraph.
 *
 * @module
 */
import { helper } from "./lib.ts";

/** Counts calls. */
let calls = 0;
const cache = new Map<string, number>();
const frozen: ReadonlySet<string> = new Set();

/** A hook. */
export const useThing = () => helper();
/** Overloaded. */
export function over(a: string): string;
export function over(a: number): number;
export function over(a: unknown) { return a; }
export interface Shape { a: number }
export type Alias = Shape;
export enum Color { Red }
/** The owner of the state. */
export class Owner {
  /** The listeners. */
  readonly #listeners = new Set<() => void>();
  private count = 0;
  static instances = 0;
  #run = () => calls++;
  /** Start it. */
  start(): void { this.#run(); }
  get size() { return this.#listeners.size; }
  constructor(readonly name: string) {}
}
export { ANSWER } from "./lib.ts";
export * from "./other.ts";
export { helper };
export default Owner;
`,
  });

  test("the module doc comment gives the summary and the description", () => {
    const main = inside(p, "main.ts");
    expect(main.file).toBe("main.ts");
    expect(main.summary).toBe("The main module.");
    expect(main.description).toBe("The main module. It does several things.");
  });

  test("a doc comment before an import is the module's", () => {
    expect(inside(p, "lib.ts").summary).toBe("Shared code.");
  });

  test("a doc comment on the first declaration is not the module's", () => {
    const p2 = program({
      "plain.ts": `/** Documents f only. */\nexport function f() {}\n`,
    });
    const plain = inside(p2, "plain.ts");
    expect(plain.summary).toBeUndefined();
    expect(plain.description).toBeUndefined();
    expect(plain.exports).toEqual([
      { name: "f", kind: "function", line: 2, summary: "Documents f only." },
    ]);
  });

  test("the exports, in the order of the file, with kinds and summaries", () => {
    const main = inside(p, "main.ts", ["useThing"]);
    expect(main.exports.map(({ members: _members, ...e }) => e)).toEqual([
      {
        name: "useThing",
        kind: "function",
        line: 17,
        summary: "A hook.",
        part: "hook:main.useThing",
      },
      { name: "over", kind: "function", line: 19, summary: "Overloaded." },
      { name: "Shape", kind: "interface", line: 22 },
      { name: "Alias", kind: "type", line: 23 },
      { name: "Color", kind: "enum", line: 24 },
      {
        name: "Owner",
        kind: "class",
        line: 26,
        summary: "The owner of the state.",
      },
      {
        name: "ANSWER",
        kind: "const",
        line: 37,
        summary: "The answer.",
        from: "module:lib",
      },
      { name: "*", kind: "all", line: 38, from: "other.ts" },
      { name: "helper", kind: "function", line: 39, from: "module:lib" },
      { name: "default", kind: "default", line: 40 },
    ]);
  });

  test("a class lists its public members", () => {
    const owner = inside(p, "main.ts").exports.find((e) => e.name === "Owner");
    expect(owner?.members).toEqual([
      { name: "instances", kind: "field", line: 30, static: true },
      { name: "start", kind: "method", line: 33, summary: "Start it." },
      { name: "size", kind: "accessor", line: 34 },
    ]);
  });

  test("the state: lets, mutable collections, and fields that are not functions", () => {
    expect(inside(p, "main.ts").state).toEqual([
      { name: "calls", kind: "let", line: 12, summary: "Counts calls." },
      { name: "cache", kind: "collection", line: 13 },
      {
        name: "#listeners",
        kind: "field",
        line: 28,
        class: "Owner",
        readonly: true,
        private: true,
        summary: "The listeners.",
      },
      {
        name: "count",
        kind: "field",
        line: 29,
        class: "Owner",
        private: true,
      },
      {
        name: "instances",
        kind: "field",
        line: 30,
        class: "Owner",
        static: true,
      },
      { name: "name", kind: "field", line: 35, class: "Owner", readonly: true },
    ]);
  });
});
