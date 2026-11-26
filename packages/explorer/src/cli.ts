/**
 * Records a timeline from a running deployment.
 *
 * ```sh
 * pnpm --filter @convex-dev/explorer record <app directory> [--out <file>]
 * ```
 *
 * See the README for the options.
 *
 * @module
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { keyMismatchWarning, resolveTarget, TargetError } from "./config.ts";
import { readAppVariables, readLocalAdminKey } from "./appFiles.ts";
import { PROJECTS } from "./projects/index.ts";
import { record, type RecordOptions } from "./recorder.ts";
import type { Scenario } from "./scenario.ts";
import { SCENARIOS } from "./scenarios/index.ts";

const USAGE = `Usage: pnpm --filter @convex-dev/explorer record <app directory> [options]

Records the function logs and the data changes of the deployment of a Convex
app into a timeline (NDJSON), until Ctrl-C. Reads a local deployment unless
--cloud is given. With --page, also opens the app's page in Chromium and
records what the page does, driven by a scenario or by you (--headed).

Options:
  --cloud                Record a cloud deployment, with CONVEX_DEPLOY_KEY
  --out <file>           Where to write the timeline (default: timeline-<time>.ndjson)
  --url <url>            The deployment URL (default: from the app's .env.local)
  --project <name>       What to keep of the app's tables: ${Object.keys(PROJECTS).join(", ")} (default: generic)
  --drop-personal-data   Replace the personal data that the project keeps
  --history <n>          Also record the last n function runs before the start
  --poll <ms>            How often to poll the data sync once it caught up (default: 1000)
  --settle <ms>          How long to wait for the other feed before writing (default: 3000)

Browser:
  --page <url>           Open the app's page, served against the deployment, and record it
  --scenario <name|file> Drive the page with a scenario, then stop: ${Object.keys(SCENARIOS).join(", ")},
                         or a module whose default export is a Scenario
  --headed               Show the browser; without --scenario, you drive the page
                         and close the browser (or press Ctrl-C) to stop
  --chromium <path>      The Chromium to run (default: EXPLORER_CHROMIUM, else
                         Playwright's: npx playwright@1.63.0 install chromium)

Local: the admin key of the deployment that \`npx convex dev\` runs, or
CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY.
Cloud: CONVEX_DEPLOY_KEY, a deploy key of the deployment.`;

class UsageError extends Error {}

async function readOptions(argv: string[]): Promise<RecordOptions> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cloud: { type: "boolean" },
      out: { type: "string" },
      url: { type: "string" },
      project: { type: "string" },
      "drop-personal-data": { type: "boolean" },
      history: { type: "string" },
      poll: { type: "string" },
      settle: { type: "string" },
      page: { type: "string" },
      scenario: { type: "string" },
      headed: { type: "boolean" },
      chromium: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    process.exit(0);
  }
  if (positionals.length !== 1) {
    throw new UsageError("Give one app directory.");
  }
  // `pnpm --filter` runs the script in this package, thus a relative path is
  // relative to where the user ran pnpm.
  const base = process.env.INIT_CWD ?? process.cwd();
  const appDir = resolve(base, positionals[0]);
  if (!existsSync(join(appDir, "convex"))) {
    throw new UsageError(`${appDir} has no convex/ directory.`);
  }
  const projectName = values.project ?? "generic";
  const baseProject = PROJECTS[projectName];
  if (baseProject === undefined) {
    throw new UsageError(
      `Unknown project "${projectName}". Known: ${Object.keys(PROJECTS).join(", ")}.`,
    );
  }
  const project =
    values["drop-personal-data"] === true
      ? { ...baseProject, keepPersonalData: false }
      : baseProject;
  const target = resolveTarget({
    target: values.cloud === true ? "cloud" : "local",
    appVariables: readAppVariables(appDir),
    env: process.env,
    url: values.url,
    localAdminKey: readLocalAdminKey(appDir),
  });
  if (target.target === "cloud") {
    const mismatch = keyMismatchWarning(target.key, target.url);
    if (mismatch !== null) {
      console.error(`Warning: ${mismatch}`);
    }
  }
  if (values.page === undefined) {
    for (const flag of ["scenario", "headed", "chromium"] as const) {
      if (values[flag] !== undefined) {
        throw new UsageError(`--${flag} needs --page.`);
      }
    }
  } else if (values.scenario === undefined && values.headed !== true) {
    throw new UsageError(
      "--page needs --scenario, or --headed for you to drive the page.",
    );
  }
  return {
    ...target,
    browser:
      values.page === undefined
        ? null
        : {
            url: values.page,
            scenario:
              values.scenario === undefined
                ? null
                : await loadScenario(values.scenario, base),
            headed: values.headed === true,
            executablePath:
              values.chromium ?? process.env.EXPLORER_CHROMIUM ?? undefined,
          },
    out: resolve(
      base,
      values.out ??
        `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`,
    ),
    project,
    history: number("--history", values.history, 0),
    pollMs: number("--poll", values.poll, 1000),
    settleMs: number("--settle", values.settle, 3000),
  };
}

async function loadScenario(name: string, base: string): Promise<Scenario> {
  const known = SCENARIOS[name];
  if (known !== undefined) {
    return known;
  }
  const path = resolve(base, name);
  if (!existsSync(path)) {
    throw new UsageError(
      `Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(", ")}, or a path to a module.`,
    );
  }
  const module = (await import(pathToFileURL(path).href)) as {
    default?: Scenario;
  };
  if (typeof module.default?.run !== "function") {
    throw new UsageError(`${path} has no default export with a run function.`);
  }
  return module.default;
}

function number(flag: string, value: string | undefined, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${flag} takes a whole number, not "${value}".`);
  }
  return parsed;
}

try {
  const options = await readOptions(process.argv.slice(2));
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  const { code } = await record(options, { stop: stop.signal });
  process.exit(code);
} catch (error) {
  if (error instanceof UsageError || error instanceof TargetError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  throw error;
}
