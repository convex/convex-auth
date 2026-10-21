/**
 * `npx @convex-dev/auth` — initialize a basic Convex Auth (v2) project.
 *
 * What it does, in order:
 *   1. Confirms `@convex-dev/auth` is a dependency of the project in the current
 *      directory. If it isn't, it crashes with the exact install command for the
 *      detected package manager (it does NOT install anything itself).
 *   2. Generates an RS256 key pair and sets the AUTH_PRIVATE_KEY / AUTH_JWKS env
 *      vars on the Convex deployment (idempotent; `--force` rotates them).
 *   3. Scaffolds `convex/auth.config.ts`, `convex/convex.config.ts` and
 *      `convex/auth.ts`. Existing files are left untouched — the CLI instead
 *      prints the content the file should contain.
 *
 * The command's behavior is expressed as a set of injectable dependencies (see
 * `defaultDeps`) so it can be driven end-to-end in unit tests with the file
 * system, key generation, and Convex env access all stubbed out.
 */

// TODO(nicolas) This is a rough draft. Ideally, we simplify the setup process
// (e.g. by skipping the need for a key pair generation + simplyfying the API)
// so that users don’t need to rely on this.

import { Command } from "commander";
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import {
  codeBlock,
  command as commandLine,
  detail,
  errorFrame,
  heading,
  item,
  pad,
  startSpinner,
  step,
  symbols,
  type Spinner,
} from "./output.ts";

const ALG = "RS256";

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
      issuer: env.CONVEX_SITE_URL,
      jwks: \`\${env.CONVEX_SITE_URL}/auth/.well-known/jwks.json\`,
      algorithm: "RS256",
    },
  ],
} satisfies AuthConfig;
`,
  "convex.config.ts": `import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});

app.use(auth, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
// TODO Add the components of your sign-in methods

export default app;
`,
  "auth.ts": `import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

// TODO Set up a sign-in method. For example:
// export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
//   setupUsernamePassword(auth, {
//     component: components.authPassword,
//     usernameComponent: components.authUsername,
//   }).attachUserCallbacks({ createUser: internal.users.createUser });
`,
};

/** The install command for a given package manager. */
type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type AuthKeys = {
  authPrivateKey: string;
  authJwks: string;
};

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
  /** Show progress while a slow step runs. Erased before the result prints. */
  spinner: (text: string) => Spinner;
  generateKeys: () => Promise<AuthKeys>;
  getEnv: (key: string) => string | null;
  setEnv: (key: string, value: string) => void;
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

/** Generate a fresh RS256 key pair as base64 PKCS8 + a JWKS JSON string. */
async function generateAuthKeys() {
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  const privatePem = await exportPKCS8(privateKey);
  const pubJwk = await exportJWK(publicKey);
  const kid = randomUUID();

  return {
    authPrivateKey: Buffer.from(privatePem).toString("base64"),
    authJwks: JSON.stringify({
      keys: [{ ...pubJwk, kid, alg: ALG, use: "sig" }],
    }),
  };
}

/** Read an env var off the current directory's Convex deployment. */
function getConvexEnv(key: string) {
  const result = spawnSync("npx", ["convex", "env", "get", key], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

/**
 * Set an env var on the current directory's Convex deployment.
 *
 * The output of the Convex CLI is captured, not printed: it echoes the value it
 * sets, and one of the values here is the private signing key. If the command
 * fails, its stderr goes into the error message.
 */
function setConvexEnv(key: string, value: string) {
  const result = spawnSync("npx", ["convex", "env", "set", key, value], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim();
    throw new Error(
      `Could not set ${key} on the Convex deployment.` +
        (reason.length > 0 ? `\n\n${indent(reason)}` : ""),
    );
  }
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
    spinner: startSpinner,
    generateKeys: generateAuthKeys,
    getEnv: getConvexEnv,
    setEnv: setConvexEnv,
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

/** What happened to the signing keys on the deployment. */
type KeyOutcome = "kept" | "written";

/** What happened to one scaffolded file. */
type FileOutcome = { name: string; status: "created" | "exists" };

/**
 * Make sure the signing keys exist on the deployment (idempotent). It returns
 * what it did; the caller prints the result.
 */
async function ensureAuthKeys(
  deps: InitDeps,
  force: boolean,
): Promise<KeyOutcome> {
  const reading = deps.spinner("Reading the deployment environment…");
  const isSet = deps.getEnv("AUTH_PRIVATE_KEY") && deps.getEnv("AUTH_JWKS");
  reading.stop();
  if (!force && isSet) return "kept";

  const generating = deps.spinner("Generating an RS256 key pair…");
  const { authPrivateKey, authJwks } = await deps.generateKeys();
  generating.stop();

  const setting = deps.spinner("Setting the keys on the Convex deployment…");
  try {
    deps.setEnv("AUTH_PRIVATE_KEY", authPrivateKey);
    deps.setEnv("AUTH_JWKS", authJwks);
  } finally {
    setting.stop();
  }
  return "written";
}

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

function reportKeys(deps: InitDeps, outcome: KeyOutcome) {
  deps.log(heading("Signing keys"));
  if (outcome === "kept") {
    deps.log(
      item(
        symbols.pending,
        "AUTH_PRIVATE_KEY and AUTH_JWKS are already set — left unchanged",
      ),
    );
    deps.log(detail("Pass --force to rotate the signing key."));
    return;
  }
  deps.log(
    item(symbols.done, "Generated an RS256 key pair for the auth JWT tokens"),
  );
  deps.log(
    item(
      symbols.done,
      "Set AUTH_PRIVATE_KEY and AUTH_JWKS on the Convex deployment",
    ),
  );
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
    step(1, "Add a sign-in method — see the TODO comments in the new files."),
  );
  deps.log(step(2, `Start your dev server: ${chalk.cyan("npx convex dev")}`));
  deps.log(`\n  ${chalk.dim("Docs:")} ${DOCS_URL}\n`);
}

/**
 * Run the full initialization against the injected `deps`. Fatal problems are
 * reported via `command.error`, which prints to stderr and exits (or throws a
 * `CommanderError` when the command has `exitOverride` set, as in tests).
 */
async function runInit(
  deps: InitDeps,
  options: { force?: boolean },
  command: Command,
) {
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

  const keyOutcome = await ensureAuthKeys(deps, options.force ?? false);
  reportKeys(deps, keyOutcome);

  reportFiles(deps, writeAuthFiles(deps, dir));
  reportNextSteps(deps);
}

/** Build the commander program, wired to the given dependencies. */
export function createProgram(deps: InitDeps = defaultDeps()) {
  const program = new Command();
  program
    .name("@convex-dev/auth")
    .description(
      "Set up Convex Auth in this project: put the signing keys on the " +
        "Convex deployment, and scaffold the convex/ files.",
    )
    .option("--force", "Regenerate the auth signing keys even if already set")
    // Mark every failure with the same symbol, both ours (`command.error`) and
    // the ones commander itself writes, which start with "error: ".
    .configureOutput({
      outputError: (text, write) =>
        write(`${symbols.failed} ${text.replace(/^error: /, "")}`),
    })
    .action((options, command) => runInit(deps, options, command));
  return program;
}

export { runInit };
