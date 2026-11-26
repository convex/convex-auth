/**
 * One TypeScript program over the source of a project, and the path helpers
 * the model uses. Nothing here knows a particular repository: the project
 * layer passes the root, the files, and how its imports resolve.
 *
 * @module
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** A path relative to `root`, with `/` separators. */
export function rootPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * The path a location shows: relative to `root`, or for a file of an npm
 * package, the path inside the package prefixed with its name and version.
 * The pnpm store directory carries a hash that changes between installs, so it
 * never appears.
 */
export function stablePath(root: string, absolute: string): string {
  const marker = `${sep}node_modules${sep}`;
  const at = absolute.lastIndexOf(marker);
  if (at === -1) {
    return rootPath(root, absolute);
  }
  const segments = absolute.slice(at + marker.length).split(sep);
  const nameLength = segments[0]!.startsWith("@") ? 2 : 1;
  const packageRoot =
    absolute.slice(0, at + marker.length) +
    segments.slice(0, nameLength).join(sep);
  let version = "";
  try {
    version =
      "@" +
      (
        JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
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

/** The files under `dir`, sorted, skipping `node_modules`, `dist`, and dot directories. */
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

export const isTypeScriptSource = (path: string) =>
  /\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts");

type ExportTarget = string | { [condition: string]: ExportTarget };

/**
 * A workspace package's `exports` entries, mapped to the source files they are
 * compiled from: `./dist/x.js` → `<srcDir>/x.ts` (or `.tsx`). Entries that
 * point into `./src/` already map to themselves.
 */
export function exportsToSource(
  packageRoot: string,
  srcDir: string,
): Map<string, string> {
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { name: string; exports: Record<string, ExportTarget> };
  const map = new Map<string, string>();
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const file = pickDefault(target);
    if (file === null) {
      continue;
    }
    const specifier = pkg.name + subpath.slice(1);
    if (file.startsWith("./src/")) {
      map.set(specifier, join(packageRoot, file));
      continue;
    }
    const match = /^\.\/dist\/(.*)\.js$/.exec(file);
    if (match === null) {
      continue;
    }
    for (const extension of [".ts", ".tsx"]) {
      const source = join(srcDir, match[1]! + extension);
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

/** The `paths` aliases of the form `"@/*": ["./*"]` that a tsconfig declares. */
export function pathAliases(dir: string): [string, string][] {
  const { config } = ts.readConfigFile(
    join(dir, "tsconfig.json"),
    ts.sys.readFile,
  );
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

export type ProgramOptions = {
  /** The repository root. Type packages resolve from it. */
  root: string;
  /** The files to analyze; their imports come along. */
  files: string[];
  /** Import specifiers resolved to a given file, e.g. a workspace package to its source. */
  sources?: Map<string, string>;
  /** Per directory, `paths` aliases (prefix → target directory relative to it). */
  aliases?: Map<string, [string, string][]>;
  /** The `types` packages to load, e.g. `["node", "vite/client"]`. */
  types?: string[];
};

export function createProgram(options: ProgramOptions): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
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
    types: options.types ?? ["node"],
    // Type packages resolve from the root, wherever this runs.
    configFilePath: join(options.root, "tsconfig.json"),
  };
  const sources = options.sources ?? new Map<string, string>();
  const aliases = [...(options.aliases ?? new Map()).entries()].map(
    ([dir, list]) => [dir.endsWith(sep) ? dir : dir + sep, list] as const,
  );
  const host = ts.createCompilerHost(compilerOptions, true);
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    _redirect,
    opts,
  ) =>
    literals.map((literal) => {
      const specifier = literal.text;
      const mapped = sources.get(specifier);
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
      for (const [dir, list] of aliases) {
        if (!containingFile.startsWith(dir)) {
          continue;
        }
        for (const [prefix, target] of list) {
          if (specifier.startsWith(prefix)) {
            const aliased = join(dir, target, specifier.slice(prefix.length));
            return ts.resolveModuleName(aliased, containingFile, opts, host);
          }
        }
      }
      return ts.resolveModuleName(specifier, containingFile, opts, host);
    });
  const program = ts.createProgram(options.files, compilerOptions, host);
  const diagnostics = program
    .getSemanticDiagnostics()
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const shown = ts.formatDiagnostics(diagnostics.slice(0, 10), {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => options.root,
      getNewLine: () => "\n",
    });
    throw new Error(
      `The source does not typecheck under the generator's program:\n${shown}`,
    );
  }
  return program;
}
