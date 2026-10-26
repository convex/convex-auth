import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveCodeIncludes } from "./codeInclude.mjs";

const rootDir = mkdtempSync(path.join(tmpdir(), "code-include-"));
const examples = path.join(rootDir, "examples");
mkdirSync(examples);
writeFileSync(
  path.join(examples, "app.ts"),
  'import { a } from "a";\n\nexport function f() {\n  return a;\n}\n',
);
writeFileSync(path.join(examples, "fence.md"), "```sh\nls\n```\n");
writeFileSync(
  path.join(examples, "nested.ts"),
  "f(() => {\n  g(() => {\n  });\n});\n",
);

const resolve = (source: string) => resolveCodeIncludes(source, { rootDir });

describe("resolveCodeIncludes", () => {
  test("inlines the file and keeps the other attributes", () => {
    expect(
      resolve('Text\n\n```ts file="examples/app.ts" title="app.ts"\n```\n'),
    ).toBe(
      'Text\n\n```ts title="app.ts"\nimport { a } from "a";\n\nexport function f() {\n  return a;\n}\n```\n',
    );
  });

  test("accepts the blank line Prettier puts in an empty block", () => {
    expect(resolve('```ts file="examples/app.ts"\n\n```')).toBe(
      '```ts\nimport { a } from "a";\n\nexport function f() {\n  return a;\n}\n```',
    );
  });

  test("marks highlights with magic comments", () => {
    expect(
      resolve(
        '```ts file="examples/app.ts" title="app.ts" highlight="export function...}" highlight="import"\n```',
      ),
    ).toBe(
      '```ts title="app.ts"\n// highlight-next-line\nimport { a } from "a";\n\n// highlight-start\nexport function f() {\n  return a;\n}\n// highlight-end\n```',
    );
  });

  test("indents a magic comment like its line", () => {
    expect(
      resolve('```ts file="examples/app.ts" highlight="return a"\n```').split(
        "\n",
      ),
    ).toContain("  // highlight-next-line");
  });

  test("uses the comment syntax of the language", () => {
    expect(
      resolve('```sh file="examples/fence.md" highlight="ls"\n```').split("\n"),
    ).toContain("# highlight-next-line");
  });

  test("indents the code like the block", () => {
    expect(resolve('  ```ts file="examples/app.ts"\n  ```')).toBe(
      '  ```ts\n  import { a } from "a";\n\n  export function f() {\n    return a;\n  }\n  ```',
    );
  });

  test("uses a longer fence for code that holds one", () => {
    expect(resolve('```md file="examples/fence.md"\n```')).toBe(
      "````md\n```sh\nls\n```\n````",
    );
  });

  test("leaves other code blocks alone, even nested examples", () => {
    const source =
      '````mdx\n```ts file="examples/missing.ts"\n```\n````\n\n```ts\nconst x = 1;\n```';
    expect(resolve(source)).toBe(source);
  });

  test.each([
    [
      '```ts file="examples/app.ts" highlight="nope"\n```',
      /"nope" was not found/,
    ],
    ['```ts file="examples/app.ts" highlight="a"\n```', /matched 2 lines/],
    [
      '```ts file="examples/app.ts" highlight="export...{"\n```',
      /"\{" was not found/,
    ],
    [
      '```ts file="examples/app.ts" highlight="export...}...return"\n```',
      /"\}\.\.\.return" was not found/,
    ],
    [
      '```ts file="examples/nested.ts" highlight="f(...});"\n```',
      /"\}\);" matched 2 lines/,
    ],
    [
      '```ts file="examples/app.ts" highlight="export...}" highlight="return"\n```',
      /highlights overlap at line 4/,
    ],
    ['```md file="examples/fence.md" highlight="ls"\n```', /language "md"/],
    ['```ts file="examples/missing.ts"\n```', /cannot read the file/],
    ['```ts file="examples/app.ts"\nconst x = 1;\n```', /must be empty/],
  ])("rejects %j", (source, message) => {
    expect(() => resolve(source)).toThrow(message);
  });
});
