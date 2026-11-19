import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConvexManagement } from "./convexApi.ts";
import { deployDemo, type DemoResult } from "./deploy.ts";
import { DEMOS_DOMAIN, demos, PROJECT_SLUG } from "./demos.ts";
import { endGroup, error, startGroup, warning, writeSummary } from "./log.ts";

const usage = `Usage: pnpm --filter demos run deploy [--only <name,...>] [--project <slug>] [--domain <domain>]

Deploys the live demos of packages/demos/src/demos.ts.

Options:
  --only <names>    Deploy only these demos (comma-separated names).
  --project <slug>  Use this Convex project, not "${PROJECT_SLUG}".
  --domain <domain> Serve the demos at <name>.<domain>, not <name>.${DEMOS_DOMAIN}.
                    Use --project and --domain together to try the
                    deployment without changing the real demos.

Environment variables:
  CONVEX_DEMOS_ACCESS_TOKEN  A team access token of the team of the demos.
  CONVEX_DEMOS_TEAM_ID       The ID of that team.`;

async function main() {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      project: { type: "string", default: PROJECT_SLUG },
      domain: { type: "string", default: DEMOS_DOMAIN },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const accessToken = process.env.CONVEX_DEMOS_ACCESS_TOKEN;
  const teamId = Number(process.env.CONVEX_DEMOS_TEAM_ID);
  if (!accessToken || !Number.isInteger(teamId)) {
    console.error(
      "Set CONVEX_DEMOS_ACCESS_TOKEN and CONVEX_DEMOS_TEAM_ID.\n\n" + usage,
    );
    process.exitCode = 1;
    return;
  }

  let selected = demos;
  if (values.only !== undefined) {
    const names = values.only.split(",").map((name) => name.trim());
    const unknown = names.filter((n) => !demos.some((d) => d.name === n));
    if (unknown.length > 0) {
      throw new Error(`Unknown demos: ${unknown.join(", ")}`);
    }
    selected = demos.filter((demo) => names.includes(demo.name));
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const demo of selected) {
    if (!existsSync(join(repoRoot, "examples", demo.example))) {
      throw new Error(`examples/${demo.example} does not exist`);
    }
  }

  const management = new ConvexManagement(accessToken, teamId);
  const project = await management.ensureProject(values.project);
  console.log(
    `${project.created ? "Created" : "Found"} the project ${values.project}`,
  );

  // A unique name, so that a run deletes only its own deploy keys.
  const deployKeyName = `demos-${process.env.GITHUB_RUN_ID ?? "local"}-${Date.now()}`;

  // One demo at a time: each one runs a build and a push, and the logs stay
  // readable.
  const results: DemoResult[] = [];
  for (const demo of selected) {
    startGroup(`Deploy ${demo.name} (examples/${demo.example})`);
    const result: DemoResult = { demo };
    results.push(result);
    try {
      await deployDemo({
        result,
        management,
        projectId: project.id,
        repoRoot,
        parentDomain: values.domain,
        deployKeyName,
      });
    } catch (e) {
      result.error = e;
      error(`${demo.name} failed`, e instanceof Error ? e.message : String(e));
    } finally {
      endGroup();
    }
  }

  // A deployment whose demo was removed from the list stays: deleting it
  // also deletes its data. Tell the reader instead.
  const names = new Set(demos.map((demo) => demo.name));
  for (const deployment of await management.listProdDeployments(project.id)) {
    if (deployment.reference && !names.has(deployment.reference)) {
      warning(
        "Deployment without a demo",
        `The deployment ${deployment.name} ("${deployment.reference}") is not in demos.ts. Delete it in the Convex dashboard if it is not necessary.`,
      );
    }
  }

  await writeSummary(summary(results));
  if (results.some((result) => result.error !== undefined)) {
    process.exitCode = 1;
  }
}

function summary(results: DemoResult[]): string {
  const rows = results.map((result) => {
    const status =
      result.error !== undefined
        ? "❌ Failed"
        : result.domainVerified
          ? "✅ Deployed"
          : "⚠️ Deployed, domain not verified";
    return `| ${result.demo.name} | ${status} | ${result.url ?? ""} | ${result.deploymentName ?? ""} |`;
  });
  return [
    "## Demos",
    "",
    "| Demo | Status | URL | Deployment |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

await main();
