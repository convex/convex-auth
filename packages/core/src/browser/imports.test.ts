import { describe, expect, test } from "vitest";

const globbed: Record<string, string> = {
  ...import.meta.glob(["./*.ts", "!./*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob(["../lib/*.ts", "!../lib/*.test.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

// The source of every module of this directory and of `lib/`, by its path in
// `src/`, e.g. `browser/storage.ts`.
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(globbed).map(([path, source]) => [
    new URL(path, "file:///src/browser/").pathname.slice("/src/".length),
    source,
  ]),
);

/** The specifiers of the imports of `source` that load code at runtime. */
function runtimeImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(
    /^(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm,
  )) {
    const [, typeOnly, clause, specifier] = match;
    // `import { type A, type B }` loads nothing either.
    const names = clause.replace(/^\{|\}$/g, "").split(",");
    const allTypes = names.every((name) => /^\s*type\s/.test(name));
    if (typeOnly === undefined && !(clause.startsWith("{") && allTypes)) {
      out.push(specifier);
    }
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) {
    out.push(match[1]);
  }
  return out;
}

/** The packages that `file` loads at runtime, through its relative imports. */
function packagesOf(file: string, seen = new Set<string>()): Set<string> {
  const packages = new Set<string>();
  if (seen.has(file)) return packages;
  seen.add(file);
  const source = sources[file];
  if (source === undefined) throw new Error(`No source for ${file}`);
  for (const specifier of runtimeImports(source)) {
    if (!specifier.startsWith(".")) {
      packages.add(specifier);
      continue;
    }
    const key = new URL(specifier, `file:///src/${file}`).pathname.slice(
      "/src/".length,
    );
    for (const p of packagesOf(key, seen)) packages.add(p);
  }
  return packages;
}

describe("the browser modules that report steps", () => {
  // `storage.ts` promises that it depends on neither React nor Convex, so
  // other client libraries can build on it. The step reports keep it so.
  test.each([
    "browser/steps.ts",
    "browser/storage.ts",
    "browser/retry.ts",
    "browser/mutex.ts",
    "browser/keyedStore.ts",
    "browser/sessionManager.ts",
  ])("%s loads no package at runtime", (file) => {
    expect([...packagesOf(file)]).toEqual([]);
  });
});
