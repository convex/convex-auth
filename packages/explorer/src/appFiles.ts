/**
 * Reads what a Convex app keeps on disk about its deployment: its `.env`
 * files, and the admin key that `npx convex dev` keeps for a local
 * deployment. Node-only.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "./config.ts";

function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

/** The variables of the app's `.env`, overridden by its `.env.local`. */
export function readAppVariables(appDir: string): Record<string, string> {
  return {
    ...readEnvFile(join(appDir, ".env")),
    ...readEnvFile(join(appDir, ".env.local")),
  };
}

/** The admin key of the app's local deployment, or null. */
export function readLocalAdminKey(appDir: string): string | null {
  const path = join(appDir, ".convex", "local", "default", "config.json");
  if (!existsSync(path)) {
    return null;
  }
  const { adminKey } = JSON.parse(readFileSync(path, "utf8")) as {
    adminKey?: unknown;
  };
  return typeof adminKey === "string" ? adminKey : null;
}
