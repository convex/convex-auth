/**
 * `npx @convex-dev/auth` — initialize a basic Convex Auth (v2) project.
 *
 * What it does, in order:
 *   1. Confirms `@convex-dev/auth` is a dependency of the project in the current
 *      directory. If it isn't, it crashes with the exact install command for the
 *      detected package manager (it does NOT install anything itself).
 *   2. Scaffolds `convex/auth.config.ts`, `convex/convex.config.ts` and
 *      `convex/auth.ts`. Existing files are left untouched — the CLI instead
 *      prints the content the file should contain.
 *
 * There is no signing material to set up: access tokens are signed with the
 * deployment's own key (`ctx.auth.signJwt`), and the public keys are served by
 * the deployment at `${CONVEX_CLOUD_URL}/.well-known/jwks.json`.
 *
 * The command's behavior is expressed as a set of injectable dependencies (see
 * `defaultDeps`) so it can be driven end-to-end in unit tests with the file
 * system all stubbed out.
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
  codeBlock,
  command as commandLine,
  errorFrame,
  heading,
  item,
  pad,
  step,
  symbols,
} from "./output.ts";

/** The package the generated `convex.config.ts` / `auth.ts` import from. */
const AUTH_PACKAGE = "@convex-dev/auth";

/** Printed at the end of a successful run. */
const DOCS_URL = "https://auth-v2.previews.convex.dev";
// TODO(nicolas) Replace by the real URL after it’s released

/** v2 ships under the `beta` tag. `latest` is still v1. */
const INSTALL_SPEC = `${AUTH_PACKAGE}@beta`;

/** Files scaffolded into the project's `convex/` directory, in write order. */
export const FILE_TEMPLATES = {
  "auth.config.ts": `import type { AuthConfig } from "convex/server";
import { env } from "./_generated/server";

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "convex",
      issuer: \`\${env.CONVEX_CLOUD_URL}/components/auth\`,
      jwks: \`\${env.CONVEX_CLOUD_URL}/.well-known/jwks.json\`,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
`,
  "convex.config.ts": `import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config.js";

const app = defineApp();

app.use(auth);
// TODO Add auth providers

export default app;
`,
  "auth.ts": `import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

// TODO Set up a login provider. For example:
// export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
//   setupUsernamePassword(auth, {
//     component: components.authPassword,
//     usernameComponent: components.authUsername,
//   }).attachUserCallbacks({ createUser: internal.users.createUser });
`,
};

/** The install command for a given package manager. */
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type InitDeps = {
  cwd: () => string;
  fs: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string) => string;
    writeFileSync: (path: string, contents: string) => void;
    mkdirSync: (path: string, options: { recursive: true }) => unknown;
  };
  log: (message: string) => void;
  warn: (message: string) => void;
  detectPackageManager: (dir: string) => string;
};

export function installCommand(packageManager: string) {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${INSTALL_SPEC}`;
    case "bun":
      return `bun add ${INSTALL_SPEC}`;
    case "yarn":
      return `yarn add ${INSTALL_SPEC}`;
    case "npm":
    default:
      return `npm install ${INSTALL_SPEC}`;
  }
}

/**
 * Detect the package manager in use, preferring the agent that actually invoked
 * the CLI (`npm_config_user_agent`) and falling back to whichever lockfile is
 * present in `dir`. Defaults to npm.
 */
export function detectPackageManager(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const userAgent = env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("bun")) return "bun";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("npm")) return "npm";

  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
    return "bun";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The real implementations, injected into `runInit` (overridden in tests). */
export function defaultDeps(): InitDeps {
  return {
    cwd: () => process.cwd(),
    fs: {
      existsSync,
      readFileSync: (path) => readFileSync(path, "utf8"),
      writeFileSync,
      mkdirSync,
    },
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    detectPackageManager,
  };
}

/**
 * Describe a `JSON.parse` failure. V8 puts the byte offset in the message; when
 * it is there, point at that position in the file itself.
 */
function describeJsonError(source: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const offset = message.match(/position (\d+)/)?.[1];
  if (offset === undefined) return indent(message);
  // The frame shows the position, so drop it from the message itself.
  const short = message.replace(/ at position \d+.*$/, "");
  return errorFrame(source, Number(offset), short);
}

/** Whether `@convex-dev/auth` appears in the package's (dev)dependencies. */
function hasAuthDependency(pkg: PackageJson) {
  return (
    AUTH_PACKAGE in (pkg.dependencies ?? {}) ||
    AUTH_PACKAGE in (pkg.devDependencies ?? {})
  );
}

/** Indent a block of text for display inside a message. */
function indent(text: string) {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join("\n");
}

/** What happened to one scaffolded file. */
type FileOutcome = { name: string; status: "created" | "exists" };

/**
 * Write each scaffolded file into `convex/`, and create that directory if it is
 * absent. A file that already exists is never overwritten. It returns one
 * outcome per template, in template order, for the caller to print.
 */
function writeAuthFiles(deps: InitDeps, dir: string): FileOutcome[] {
  const convexDir = join(dir, "convex");
  if (!deps.fs.existsSync(convexDir)) {
    deps.fs.mkdirSync(convexDir, { recursive: true });
  }

  return Object.entries(FILE_TEMPLATES).map(([name, content]) => {
    const filePath = join(convexDir, name);
    if (deps.fs.existsSync(filePath)) {
      return { name, status: "exists" as const };
    }
    deps.fs.writeFileSync(filePath, content);
    return { name, status: "created" as const };
  });
}

/**
 * Print one aligned line per file, then the full content of each file that
 * already exists. The contents come last so that they do not break up the list.
 */
function reportFiles(deps: InitDeps, outcomes: FileOutcome[]) {
  const width = Math.max(...outcomes.map(({ name }) => name.length));

  deps.log(heading("Files"));
  for (const { name, status } of outcomes) {
    const label = pad(`convex/${name}`, width + "convex/".length);
    if (status === "created") {
      deps.log(item(symbols.done, `${label}  ${chalk.dim("created")}`));
    } else {
      deps.log(
        item(symbols.skipped, `${label}  ${chalk.dim("already exists")}`),
      );
    }
  }

  const existing = outcomes.filter(({ status }) => status === "exists");
  for (const { name } of existing) {
    deps.warn(heading(`convex/${name} already exists`));
    deps.warn("  This file was not changed. Make sure that it contains:\n");
    deps.warn(codeBlock(FILE_TEMPLATES[name as keyof typeof FILE_TEMPLATES]));
  }
}

function reportNextSteps(deps: InitDeps) {
  deps.log(heading("Next steps"));
  deps.log(
    step(1, "Add a login provider — see the TODO comments in the new files."),
  );
  deps.log(step(2, `Start your dev server: ${chalk.cyan("npx convex dev")}`));
  deps.log(`\n  ${chalk.dim("Docs:")} ${DOCS_URL}\n`);
}

/**
 * Run the full initialization against the injected `deps`. Fatal problems are
 * reported via `command.error`, which prints to stderr and exits (or throws a
 * `CommanderError` when the command has `exitOverride` set, as in tests).
 */
async function runInit(deps: InitDeps, command: Command) {
  const dir = deps.cwd();
  const pkgPath = join(dir, "package.json");

  if (!deps.fs.existsSync(pkgPath)) {
    command.error(
      `No package.json found in ${dir}.\n` +
        "Run this command from the root of your project.",
    );
    return;
  }

  let pkg: PackageJson;
  const pkgSource = deps.fs.readFileSync(pkgPath);
  try {
    pkg = JSON.parse(pkgSource);
  } catch (error) {
    command.error(
      `Could not parse ${pkgPath} as JSON.\n\n${describeJsonError(pkgSource, error)}`,
    );
    return;
  }

  if (!hasAuthDependency(pkg)) {
    const packageManager = deps.detectPackageManager(dir);
    command.error(
      `${AUTH_PACKAGE} is not a dependency of this project.\n\n` +
        "Install it, then run this command again:\n\n" +
        `${commandLine(installCommand(packageManager))}\n`,
    );
    return;
  }

  deps.log(`${chalk.bold("Convex Auth")} ${chalk.dim(`setup in ${dir}`)}`);

  reportFiles(deps, writeAuthFiles(deps, dir));
  reportNextSteps(deps);
}

/** Build the commander program, wired to the given dependencies. */
export function createProgram(deps: InitDeps = defaultDeps()) {
  const program = new Command();
  program
    .name("@convex-dev/auth")
    .description(
      "Set up Convex Auth in this project: scaffold the convex/ files.",
    )
    // Mark every failure with the same symbol, both ours (`command.error`) and
    // the ones commander itself writes, which start with "error: ".
    .configureOutput({
      outputError: (text, write) =>
        write(`${symbols.failed} ${text.replace(/^error: /, "")}`),
    })
    .action((_options, command) => runInit(deps, command));
  return program;
}

export { runInit };
