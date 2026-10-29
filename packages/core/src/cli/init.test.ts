// @vitest-environment node
import chalk from "chalk";
import { beforeAll, describe, expect, test } from "vitest";
import {
  createProgram,
  detectPackageManager,
  FILE_TEMPLATES,
  installCommand,
} from "./program.ts";

const PROJECT = "/project";

// The CLI colors its output when it writes to a terminal. The assertions below
// match plain text, so turn color off whatever the terminal running the tests.
beforeAll(() => {
  chalk.level = 0;
});

/** Minimal in-memory stand-in for the subset of `node:fs` the CLI uses. */
function makeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      const contents = files.get(p);
      if (contents === undefined) throw new Error(`ENOENT: ${p}`);
      return contents;
    },
    writeFileSync: (p: string, contents: string) => {
      files.set(p, contents);
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
  };
}

type Overrides = {
  files?: Record<string, string>;
  detectPackageManager?: (dir: string) => string;
};

function makeDeps(overrides: Overrides = {}) {
  const fs = makeFs(overrides.files);
  const logs: string[] = [];
  const warns: string[] = [];
  const deps = {
    cwd: () => PROJECT,
    fs,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
    detectPackageManager: overrides.detectPackageManager ?? (() => "npm"),
  };
  return { deps, fs, logs, warns };
}

/** Drive the CLI exactly as a user would, but capture output/exit. */
async function runCli(deps: unknown, args: string[] = []) {
  const stderr: string[] = [];
  // The stub deps intentionally implement only the narrow surface the CLI uses,
  // so widen to the parameter type the loosely-typed .mjs expects.
  const program = createProgram(deps as Parameters<typeof createProgram>[0]);
  program.exitOverride();
  program.configureOutput({
    writeErr: (s) => stderr.push(s),
    writeOut: () => {},
  });
  let error: Error | undefined;
  try {
    await program.parseAsync(["node", "convex-auth", ...args]);
  } catch (e) {
    error = e as Error;
  }
  return { error, stderr: stderr.join("") };
}

const pkgWithAuth = JSON.stringify({
  dependencies: { "@convex-dev/auth": "^2.0.0" },
});

describe("convex-auth init CLI", () => {
  test("crashes with the install command when @convex-dev/auth is missing", async () => {
    const { deps, fs } = makeDeps({
      files: { "/project/package.json": JSON.stringify({ dependencies: {} }) },
      detectPackageManager: () => "pnpm",
    });

    const { error } = await runCli(deps);

    expect(error).toBeDefined();
    expect(error!.message).toContain("is not a dependency");
    expect(error!.message).toContain("pnpm add @convex-dev/auth@beta");
    // It must not write any files on this path.
    expect(fs.files.has("/project/convex/auth.ts")).toBe(false);
  });

  test("crashes when there is no package.json", async () => {
    const { deps } = makeDeps({ files: {} });
    const { error } = await runCli(deps);
    expect(error).toBeDefined();
    expect(error!.message).toContain("No package.json found");
  });

  test("crashes when package.json is not valid JSON", async () => {
    const { deps } = makeDeps({
      files: { "/project/package.json": "{ not json" },
    });
    const { error } = await runCli(deps);
    expect(error).toBeDefined();
    expect(error!.message).toContain("Could not parse");
  });

  test("scaffolds all files on the happy path", async () => {
    const { deps, fs, logs } = makeDeps({
      files: { "/project/package.json": pkgWithAuth },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();

    // The convex/ directory is created and every template is written verbatim.
    expect(fs.dirs.has("/project/convex")).toBe(true);
    for (const [name, content] of Object.entries(FILE_TEMPLATES)) {
      expect(fs.files.get(`/project/convex/${name}`)).toBe(content);
      expect(logs.join("\n")).toMatch(
        new RegExp(`convex/${name.replace(".", "\\.")} +created`),
      );
    }
  });

  test("reports the happy path as one grouped summary", async () => {
    const { deps, logs } = makeDeps({
      files: { "/project/package.json": pkgWithAuth },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    expect(logs.join("\n")).toMatchInlineSnapshot(`
      "Convex Auth setup in /project

      Files
        ✔ convex/auth.config.ts    created
        ✔ convex/convex.config.ts  created
        ✔ convex/auth.ts           created

      Next steps
        1. Add a sign-in method — see the TODO comments in the new files.
        2. Start your dev server: npx convex dev

        Docs: https://auth-v2.previews.convex.dev
      "
    `);
  });

  test("recognizes @convex-dev/auth listed under devDependencies", async () => {
    const { deps, fs } = makeDeps({
      files: {
        "/project/package.json": JSON.stringify({
          devDependencies: { "@convex-dev/auth": "^2.0.0" },
        }),
      },
    });
    const { error } = await runCli(deps);
    expect(error).toBeUndefined();
    expect(fs.files.has("/project/convex/auth.ts")).toBe(true);
  });

  test("does not overwrite an existing file, but warns with its content", async () => {
    const { deps, fs, warns } = makeDeps({
      files: {
        "/project/package.json": pkgWithAuth,
        "/project/convex/auth.ts": "// my hand-written auth.ts",
      },
    });

    const { error } = await runCli(deps);

    expect(error).toBeUndefined();
    // Untouched…
    expect(fs.files.get("/project/convex/auth.ts")).toBe(
      "// my hand-written auth.ts",
    );
    // …but the warning tells the user what it should contain.
    const warning = warns.join("\n");
    expect(warning).toContain("convex/auth.ts already exists");
    // The block is printed as it is, with no gutter, so it can be copied.
    expect(warning).toContain(FILE_TEMPLATES["auth.ts"].trimEnd());
    // The other files were still created.
    expect(fs.files.get("/project/convex/convex.config.ts")).toBe(
      FILE_TEMPLATES["convex.config.ts"],
    );
  });
});

describe("FILE_TEMPLATES", () => {
  // TypeScript 6 no longer loads `@types/node` by default, and the
  // `convex/tsconfig.json` of a new project lists no `types`, so the generated
  // files must compile without Node's globals. A project with
  // `verbatimModuleSyntax` also needs type-only imports to use `import type`.
  test("auth.config.ts compiles without Node types", () => {
    const authConfig = FILE_TEMPLATES["auth.config.ts"];
    expect(authConfig).not.toContain("process.");
    expect(authConfig).toContain(
      'import type { AuthConfig } from "convex/server";',
    );
  });
});

describe("installCommand", () => {
  test.each([
    ["npm", "npm install"],
    ["pnpm", "pnpm add"],
    ["bun", "bun add"],
    ["yarn", "yarn add"],
  ])("%s uses the right add command", (pm, prefix) => {
    expect(installCommand(pm)).toContain(prefix);
    expect(installCommand(pm)).toContain("@convex-dev/auth@beta");
  });

  test("unknown package managers fall back to npm", () => {
    expect(installCommand("who-knows")).toContain("npm install");
  });
});

describe("detectPackageManager", () => {
  test("prefers the invoking agent from npm_config_user_agent", () => {
    expect(
      detectPackageManager("/nowhere", {
        npm_config_user_agent: "pnpm/9.0.0 npm/? node/v20",
      }),
    ).toBe("pnpm");
    expect(
      detectPackageManager("/nowhere", {
        npm_config_user_agent: "bun/1.1.0",
      }),
    ).toBe("bun");
  });

  test("falls back to npm with no signal", () => {
    expect(detectPackageManager("/nowhere", {})).toBe("npm");
  });
});
