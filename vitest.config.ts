import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
// The plugin that apps use (`@convex-dev/auth/test/vitest`), from source so
// the tests don't depend on a build.
import { convexAuthTest } from "./packages/core/src/vitest/index.ts";

const rootDir = dirname(fileURLToPath(import.meta.url));

// One project per workspace directory, discovered from disk so new
// packages/examples are picked up automatically without editing this file.
const projects = ["packages", "examples"].flatMap((group) =>
  readdirSync(join(rootDir, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      plugins: [convexAuthTest()],
      test: {
        name: entry.name,
        root: `${group}/${entry.name}`,
        // Convex functions run in an edge-like runtime; convex-test relies on it.
        environment: "edge-runtime",
        // Tests live under src/ (packages) or convex/ (examples). Scoping the
        // include keeps the globber out of heavy dirs (e.g. Rust `target/`).
        include: ["src/**/*.test.{ts,tsx}", "convex/**/*.test.{ts,tsx}"],
        exclude: [...configDefaults.exclude, "**/target/**", "**/pkg/**"],
        passWithNoTests: true, // TODO(nicolas) remove?
      },
    })),
);

// Single Vitest config for the whole monorepo (Vitest "projects"). Run from the
// repo root with `pnpm test`; target one package with `pnpm test --project <name>`.
export default defineConfig({
  test: { projects },
});
