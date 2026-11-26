/**
 * Writes `structure.json`, or with `--check`, fails when the committed file
 * differs from what the source gives.
 *
 * @module
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "prettier";
import { buildModel } from "./extract.ts";
import { repoRoot } from "./program.ts";

const outFile = join(
  repoRoot,
  "packages",
  "explorer-structure",
  "structure.json",
);
const model = buildModel();
// Written as Prettier writes it, so `pnpm format:check` and `--check` agree.
const text = await format(JSON.stringify(model), { parser: "json" });

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(outFile, "utf8");
  } catch {
    // Missing counts as stale.
  }
  if (committed !== text) {
    console.error(
      "packages/explorer-structure/structure.json is stale. Run `pnpm --filter @convex-dev/explorer-structure generate`.",
    );
    process.exit(1);
  }
  console.log("structure.json is up to date.");
} else {
  writeFileSync(outFile, text);
}
console.log(
  `parts: ${JSON.stringify(model.counts.parts)}\n` +
    `dependencies: ${JSON.stringify(model.counts.dependencies)}\n` +
    `unresolved: ${JSON.stringify(model.counts.unresolved)}`,
);
