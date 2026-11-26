/**
 * One TypeScript program over the source of the core, the example apps, and
 * the files they import.
 *
 * The examples import `@convex-dev/auth/...`, whose `exports` map points at the
 * compiled `dist/`. The program resolves those imports to `src/` instead, so
 * the call graph runs through the source and every location is a source
 * location.
 *
 * @module
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

export const repoRoot = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "..",
);
export const coreRoot = join(repoRoot, "packages", "core");
export const coreSrc = join(coreRoot, "src");
export const examplesRoot = join(repoRoot, "examples");

/** A repository-relative path with `/` separators. */
export function repoPath(absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join("/");
}

/**
 * The repository-relative path of a file, or for a file of an npm package, the
 * path inside the package prefixed with its name and version. The pnpm store
 * directory carries a hash that changes between installs, so it never appears.
 */
export function stablePath(absolute: string): string {
  const marker = `${sep}node_modules${sep}`;
  const at = absolute.lastIndexOf(marker);
  if (at === -1) {
    return repoPath(absolute);
  }
  const segments = absolute.slice(at + marker.length).split(sep);
  const nameLength = segments[0]!.startsWith("@") ? 2 : 1;
  const root =
    absolute.slice(0, at + marker.length) +
    segments.slice(0, nameLength).join(sep);
  let version = "";
  try {
    version =
      "@" +
      (
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
  } catch {
    // A package without a readable version keeps its bare name.
  }
  return [
    segments.slice(0, nameLength).join("/") + version,
    ...segments.slice(nameLength),
  ].join("/");
}

export function listFiles(
  dir: string,
  filter: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry.startsWith(".")
      ) {
        continue;
      }
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else if (filter(path)) {
        out.push(path);
      }
    }
  };
  visit(dir);
  return out;
}

type ExportTarget = string | { [condition: string]: ExportTarget };

/** `@convex-dev/auth/<subpath>` → the source file it is compiled from. */
function coreExportsToSource(): Map<string, string> {
  const pkg = JSON.parse(
    readFileSync(join(coreRoot, "package.json"), "utf8"),
  ) as {
    exports: Record<string, ExportTarget>;
  };
  const map = new Map<string, string>();
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const file = pickDefault(target);
    if (file === null) {
      continue;
    }
    const specifier = "@convex-dev/auth" + subpath.slice(1);
    if (file.startsWith("./src/")) {
      map.set(specifier, join(coreRoot, file));
      continue;
    }
    const match = /^\.\/dist\/(.*)\.js$/.exec(file);
    if (match === null) {
      continue;
    }
    for (const extension of [".ts", ".tsx"]) {
      const source = join(coreSrc, match[1]! + extension);
      try {
        statSync(source);
        map.set(specifier, source);
        break;
      } catch {
        // Try the next extension.
      }
    }
  }
  return map;
}

function pickDefault(target: ExportTarget): string | null {
  if (typeof target === "string") {
    return target;
  }
  if (target.default !== undefined) {
    return pickDefault(target.default);
  }
  return null;
}

const isSourceFile = (path: string) =>
  /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts");

/** The files excluded from the published build: tests and in-repo helpers. */
export function isInRepoOnly(absolute: string): boolean {
  const rel = relative(coreSrc, absolute).split(sep).join("/");
  return (
    /\.(test|script|fixture)\.tsx?$/.test(rel) ||
    rel.startsWith("testing/") ||
    rel.startsWith("components/password/scripts/") ||
    [
      "components/passkeyTestSetup.ts",
      "components/emailTestSetup.ts",
      "components/totpTestSetup.ts",
      "methods/oauth/testFlow.ts",
      "react/testSignInApi.ts",
    ].includes(rel)
  );
}

export function examples(): string[] {
  return readdirSync(examplesRoot)
    .filter((name) => statSync(join(examplesRoot, name)).isDirectory())
    .sort();
}

/** The `paths` aliases of the form `"@/*": ["./*"]` that an example's tsconfig declares. */
function pathAliases(dir: string): [string, string][] {
  const configFile = join(dir, "tsconfig.json");
  const { config } = ts.readConfigFile(configFile, ts.sys.readFile);
  const paths = (config?.compilerOptions?.paths ?? {}) as Record<
    string,
    string[]
  >;
  return Object.entries(paths).flatMap(([pattern, targets]) =>
    pattern.endsWith("*") && targets[0]?.endsWith("*")
      ? [[pattern.slice(0, -1), targets[0].slice(0, -1)] as [string, string]]
      : [],
  );
}

export function createProgram(): ts.Program {
  const roots = [
    ...listFiles(coreSrc, (path) => isSourceFile(path) && !isInRepoOnly(path)),
    ...examples().flatMap((example) =>
      listFiles(
        join(examplesRoot, example),
        (path) => isSourceFile(path) && !/\.test\.tsx?$/.test(path),
      ),
    ),
  ];
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    allowJs: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    noEmit: true,
    // `import.meta.env` in the Vite examples.
    types: ["node", "vite/client"],
    // Type packages resolve from the repository root, wherever this runs.
    configFilePath: join(repoRoot, "tsconfig.base.json"),
  };
  const coreExports = coreExportsToSource();
  const examplePaths = new Map(
    examples().map((example) => [
      join(examplesRoot, example) + sep,
      pathAliases(join(examplesRoot, example)),
    ]),
  );
  const host = ts.createCompilerHost(options, true);
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    _redirect,
    opts,
  ) =>
    literals.map((literal) => {
      const specifier = literal.text;
      const mapped = coreExports.get(specifier);
      if (mapped !== undefined) {
        return {
          resolvedModule: {
            resolvedFileName: mapped,
            extension: mapped.endsWith(".tsx")
              ? ts.Extension.Tsx
              : ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        };
      }
      for (const [root, aliases] of examplePaths) {
        if (!containingFile.startsWith(root)) {
          continue;
        }
        for (const [prefix, target] of aliases) {
          if (specifier.startsWith(prefix)) {
            const aliased = join(root, target, specifier.slice(prefix.length));
            return ts.resolveModuleName(aliased, containingFile, opts, host);
          }
        }
      }
      return ts.resolveModuleName(specifier, containingFile, opts, host);
    });
  return ts.createProgram(roots, options, host);
}
