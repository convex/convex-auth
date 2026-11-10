import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

// Handles loading .wasm modules.
// In production, the bundler used by the Convex CLI does this automatically.
function wasmModulePlugin(): Plugin {
  return {
    name: "wasm-as-webassembly-module",
    // Run before Vite's built-in `.wasm` handling, which would otherwise try to
    // ESM-resolve the module's wasm-bindgen imports (e.g. "wbg") and fail.
    enforce: "pre",
    load(id) {
      if (!id.endsWith(".wasm")) return null;
      const base64 = readFileSync(id).toString("base64");
      return `const bytes = Uint8Array.from(atob(${JSON.stringify(
        base64,
      )}), (c) => c.charCodeAt(0));
export default new WebAssembly.Module(bytes);`;
    },
  };
}

const rootDir = dirname(fileURLToPath(import.meta.url));

// One project per workspace directory, discovered from disk so new
// packages/examples are picked up automatically without editing this file.
const projects = ["packages", "examples"].flatMap((group) =>
  readdirSync(join(rootDir, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      plugins: [wasmModulePlugin()],
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
        server: {
          deps: {
            // convex-test loads function modules dynamically; inlining keeps
            // that resolution working under Vitest's transform pipeline.
            // `password-hash-wasm` is inlined so its `.wasm` import is handled
            // by `wasmModulePlugin`.
            inline: ["convex-test", "password-hash-wasm"],
          },
        },
      },
    })),
);

// Single Vitest config for the whole monorepo (Vitest "projects"). Run from the
// repo root with `pnpm test`; target one package with `pnpm test --project <name>`.
export default defineConfig({
  test: { projects },
});
