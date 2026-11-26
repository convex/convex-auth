/**
 * The generic layer from the command line, for any Convex project:
 *
 *   tsx src/generate/convex/cli.ts <repository root> <convex dir>... [--frontends] [--types=node,vite/client]
 *
 * Prints the structure model as JSON.
 *
 * @module
 */
import { resolve } from "node:path";
import { buildConvexModel } from "./index.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const typesFlag = process.argv.find((a) => a.startsWith("--types="));
const [root, ...apps] = args;
if (root === undefined || apps.length === 0) {
  console.error(
    "Usage: cli.ts <repository root> <convex dir>... [--frontends] [--types=node,vite/client]",
  );
  process.exit(2);
}
const model = buildConvexModel({
  root: resolve(root),
  apps: apps.map((dir) => resolve(dir)),
  frontends: process.argv.includes("--frontends"),
  types: typesFlag?.slice("--types=".length).split(","),
});
process.stdout.write(JSON.stringify(model, null, 2) + "\n");
