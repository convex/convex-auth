import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import wasmModule from "vite-plugin-wasm-module";
import { configDefaults, defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// One project per workspace directory, discovered from disk so new
// packages/examples are picked up automatically without editing this file.
const projects = ["packages", "examples"].flatMap((group) =>
  readdirSync(join(rootDir, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      // Loads each `.wasm` import as a `WebAssembly.Module`, as the bundler of
      // the Convex CLI does.
      plugins: [wasmModule()],
      test: {
        name: entry.name,
        root: `${group}/${entry.name}`,
        // Convex functions run in an edge-like runtime; convex-test relies on it.
        environment: "edge-runtime",
        // The deployment sets this variable. The core needs it to check the
        // issuer of a token, and convex-test signs tokens under it.
        env: { CONVEX_CLOUD_URL: "https://some-deployment.convex.cloud" },
        // Tests live under src/ (packages) or convex/ (examples). Scoping the
        // include keeps the globber out of heavy dirs (e.g. Rust `target/`).
        include: ["src/**/*.test.{ts,tsx}", "convex/**/*.test.{ts,tsx}"],
        exclude: [...configDefaults.exclude, "**/target/**", "**/pkg/**"],
        server: {
          deps: {
            // convex-test loads function modules dynamically; inlining keeps
            // that resolution working under Vitest's transform pipeline.
            // `password-hash-wasm` is inlined so its `.wasm` import is handled
            // by `vite-plugin-wasm-module`.
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
