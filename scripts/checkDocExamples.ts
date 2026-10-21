#!/usr/bin/env tsx
// Typechecks the code examples in the doc comments of `@convex-dev/auth`.
// Run it after `pnpm build`, because the examples import the package from
// `packages/core/dist/`, like an app does.
//
// TypeDoc copies the doc comments to the API reference, and the published
// declarations keep them for the editor. `tsc` does not read the code in a
// comment, thus an example can refer to an option or a return value that does
// not exist, and no other check finds it.
//
// The script finds each ```ts and ```tsx block in a `/** ... */` comment
// under `packages/core/src/`, and typechecks it as a module of its own:
//
//   - An example can use a name that it does not import. When `tsc` cannot
//     find a name, the script imports it from the public entry point that
//     exports it (`@convex-dev/auth/...`, then `react`, `convex/react`,
//     `convex/browser`, `convex/server`, `convex/values`), and from the
//     commented file as the last choice. The entry point of the commented file comes first.
//   - The values of the app that an example uses (`api`, `internal`,
//     `components`, `auth`, `ctx`, `env`) have the type `any`. `PRELUDE`
//     declares them, and the values of the frameworks. An example can declare
//     its own value with the same name.
//   - `import ... from "../convex/_generated/api"` and
//     `import ... from "./_generated/server"` resolve to stubs: a ```tsx
//     example is in `src/` of an app, and a ```ts example is in `convex/`.
//
// To keep an example out of the check, write the language as `ts skip-check`
// (or `tsx skip-check`). Use it only for code that cannot compile, for
// example the code of a third-party framework that is not installed here.
//
// Usage: pnpm check:doc-examples

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(root, "packages", "core");
const srcDir = join(coreDir, "src");
// The examples are not on disk. They are in `packages/core/` so that
// `@convex-dev/auth` resolves to the package itself through its `exports`
// map, and the other packages resolve from `packages/core/node_modules/`.
const appDir = join(coreDir, ".doc-examples");

const PRELUDE = `
declare const api: any;
declare const internal: any;
declare const components: any;
declare const auth: any;
declare const ctx: any;
declare const env: any;
declare const request: Request;
declare const app: ReturnType<typeof import("convex/server").defineApp>;
declare const query: typeof import("convex/server").queryGeneric;
declare const oauth: typeof import("@convex-dev/auth/components/oauth/convex.config").default;
declare const google: typeof import("@convex-dev/auth/components/google/convex.config").default;
declare const apple: typeof import("@convex-dev/auth/components/apple/convex.config").default;
declare const github: typeof import("@convex-dev/auth/components/github/convex.config").default;
declare function Navigate(props: { to: string; replace?: boolean }): null;
declare module "expo-secure-store" {
  export function getItemAsync(key: string): Promise<string | null>;
  export function setItemAsync(key: string, value: string): Promise<void>;
  export function deleteItemAsync(key: string): Promise<void>;
}
`;

const STUBS: Record<string, string> = {
  "convex/_generated/api.ts": `
export declare const api: any;
export declare const internal: any;
export declare const components: any;
`,
  "convex/_generated/server.ts": `
export declare const env: any;
export {
  queryGeneric as query,
  mutationGeneric as mutation,
  actionGeneric as action,
  internalQueryGeneric as internalQuery,
  internalMutationGeneric as internalMutation,
  internalActionGeneric as internalAction,
  httpActionGeneric as httpAction,
} from "convex/server";
`,
};

const THIRD_PARTY_MODULES = [
  "react",
  "convex/react",
  "convex/browser",
  "convex/server",
  "convex/values",
];

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  types: ["node", "vite/client"],
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  allowImportingTsExtensions: true,
  // `React.ReactNode` without an import.
  allowUmdGlobalAccess: true,
};

interface Example {
  /** The commented file, relative to the repository root. */
  file: string;
  /** The line of the first line of code, 1-based. */
  line: number;
  lang: "ts" | "tsx";
  code: string;
  /** The path of the module that holds the example. */
  path: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|fixture)\.tsx?$/.test(entry.name),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.split(sep).includes("_generated"))
    .sort();
}

function findExamples(path: string): Example[] {
  const text = readFileSync(path, "utf8");
  const file = relative(root, path);
  const examples: Example[] = [];
  for (const match of text.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const firstLine = text.slice(0, match.index).split("\n").length;
    const lines = match[0]
      .split("\n")
      .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*(?!\/)) ?/, ""));
    for (let i = 0; i < lines.length; i++) {
      const open = /^```(tsx?)\b(.*)$/.exec(lines[i]);
      if (open === null) continue;
      const end = lines.findIndex((line, j) => j > i && /^```\s*$/.test(line));
      if (end === -1) {
        throw new Error(`${file}:${firstLine + i}: the code block has no end.`);
      }
      const lang = open[1] as "ts" | "tsx";
      if (!/\bskip-check\b/.test(open[2])) {
        const line = firstLine + i + 1;
        examples.push({
          file,
          line,
          lang,
          code: lines.slice(i + 1, end).join("\n"),
          path: join(
            appDir,
            lang === "tsx" ? "src" : "convex",
            `${file.replaceAll(sep, "_")}_${line}.${lang}`,
          ),
        });
      }
      i = end;
    }
  }
  return examples;
}

/** The public import specifiers of `@convex-dev/auth`, from its `exports`. */
function packageEntryPoints(): string[] {
  const pkg = JSON.parse(
    readFileSync(join(coreDir, "package.json"), "utf8"),
  ) as { name: string; exports: Record<string, unknown> };
  return Object.entries(pkg.exports)
    .filter(
      ([key, target]) =>
        target !== null &&
        key !== "./package.json" &&
        !key.endsWith(".js") &&
        !key.includes("_generated") &&
        // The test helpers ship as source and need Vite.
        !key.endsWith("/test"),
    )
    .map(([key]) => (key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`));
}

/** The module specifier of `entryPoint` for the file at `from`. */
function specifierFor(from: string, entryPoint: string): string {
  if (!entryPoint.startsWith("/")) return entryPoint;
  const path = relative(dirname(from), entryPoint).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function createProgram(files: Map<string, string>): ts.Program {
  const host = ts.createCompilerHost(compilerOptions);
  const { fileExists, directoryExists, readFile, getSourceFile } = host;
  host.fileExists = (path) => files.has(path) || fileExists(path);
  host.directoryExists = (path) =>
    path === appDir ||
    path.startsWith(appDir + sep) ||
    (directoryExists?.(path) ?? true);
  host.readFile = (path) => files.get(path) ?? readFile(path);
  host.getSourceFile = (path, languageVersion, ...rest) => {
    const text = files.get(path);
    return text === undefined
      ? getSourceFile(path, languageVersion, ...rest)
      : ts.createSourceFile(path, text, languageVersion, true);
  };
  return ts.createProgram([...files.keys()], compilerOptions, host);
}

const examples = sourceFiles(srcDir).flatMap(findExamples);

const baseFiles = new Map<string, string>([
  [join(appDir, "prelude.d.ts"), PRELUDE],
  ...Object.entries(STUBS).map(
    ([path, text]) => [join(appDir, path), text] as [string, string],
  ),
]);

// The names that each import source exports.
const entryPoints = [...packageEntryPoints(), ...THIRD_PARTY_MODULES];
const commentedFiles = [...new Set(examples.map((e) => join(root, e.file)))];
const sources = [...entryPoints, ...commentedFiles];
const exportsIndex = join(appDir, "exports.ts");
const indexProgram = createProgram(
  new Map([
    ...baseFiles,
    [
      exportsIndex,
      sources
        .map(
          (source, i) =>
            `import * as m${i} from "${specifierFor(exportsIndex, source)}";`,
        )
        .join("\n"),
    ],
  ]),
);
const checker = indexProgram.getTypeChecker();
const exportsOf = new Map<string, Set<string>>();
for (const statement of indexProgram.getSourceFile(exportsIndex)!.statements) {
  if (!ts.isImportDeclaration(statement)) continue;
  const source = sources[exportsOf.size];
  const symbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
  if (symbol === undefined) {
    throw new Error(`Cannot resolve "${source}".`);
  }
  exportsOf.set(
    source,
    new Set(
      checker
        .getExportsOfModule(symbol)
        .map((s) => s.name)
        .filter((name) => name !== "default"),
    ),
  );
}

/** The entry point of the package that exports the commented file. */
function ownEntryPoint(example: Example): string | undefined {
  const stem = example.file
    .replace(/^packages\/core\/src\//, "")
    .replace(/(\/index)?\.tsx?$/, "");
  return entryPoints.find((e) => e === `@convex-dev/auth/${stem}`);
}

function sourceOf(example: Example, name: string): string | undefined {
  const own = ownEntryPoint(example);
  const candidates = [
    ...(own === undefined ? [] : [own]),
    ...entryPoints,
    join(root, example.file),
  ];
  return candidates.find((source) => exportsOf.get(source)?.has(name));
}

const missingName = /^Cannot find name '(\w+)'/;

function check(
  imports: Map<Example, Map<string, string[]>>,
): Map<Example, readonly ts.Diagnostic[]> {
  const header = (example: Example) =>
    [...(imports.get(example) ?? new Map<string, string[]>())]
      .map(
        ([source, names]) =>
          `import { ${names.join(", ")} } from "${specifierFor(example.path, source)}";\n`,
      )
      .join("");
  const program = createProgram(
    new Map([
      ...baseFiles,
      ...examples.map(
        (e) =>
          // `export {}` makes the example a module, even when it has no
          // import and no export. It comes last to keep the line numbers.
          [e.path, `${header(e)}${e.code}\nexport {};\n`] as [string, string],
      ),
    ]),
  );
  return new Map(
    examples.map((e) => [
      e,
      ts.getPreEmitDiagnostics(program, program.getSourceFile(e.path)),
    ]),
  );
}

// First pass: find the names that each example does not import.
const imports = new Map<Example, Map<string, string[]>>();
for (const [example, diagnostics] of check(new Map())) {
  const bySource = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "");
    const name = missingName.exec(message)?.[1];
    if (name === undefined) continue;
    const source = sourceOf(example, name);
    if (source === undefined) continue;
    const names = bySource.get(source) ?? [];
    if (!names.includes(name)) names.push(name);
    bySource.set(source, names);
  }
  imports.set(example, bySource);
}

// Second pass: check each example with its imports.
const errors: string[] = [];
for (const [example, diagnostics] of check(imports)) {
  const headerLines = imports.get(example)!.size;
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n  ",
    );
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      errors.push(`${example.file}:${example.line}: ${message}`);
      continue;
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    const sourceLine = example.line + line - headerLines;
    errors.push(
      `${example.file}:${sourceLine}: TS${diagnostic.code}: ${message}`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(
    `\n${errors.length} error(s) in the doc comment examples. See scripts/checkDocExamples.ts.`,
  );
  process.exit(1);
}
console.log(`Checked ${examples.length} doc comment examples.`);
