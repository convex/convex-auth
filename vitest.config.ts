import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import wasmModule from "vite-plugin-wasm-module";
import { configDefaults, defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

// The tests of the Svelte bindings of `packages/core`, which run in their own
// project, with the Svelte compiler (see below).
const svelteTests = [
  "src/svelte/**/*.test.ts",
  "src/ssr/sveltekit/**/*.test.ts",
  "src/methods/*/svelte*.test.ts",
];

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
        exclude: [
          ...configDefaults.exclude,
          "**/target/**",
          "**/pkg/**",
          ...(entry.name === "core" ? svelteTests : []),
        ],
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

// The Svelte bindings of `packages/core`. The Svelte compiler compiles the
// runes of the `.svelte.ts` modules (and of `.svelte.test.ts` tests), and the
// `.svelte` components of the tests. `$app/*` are the modules that SvelteKit
// provides to an app; the tests get stand-ins.
const appModules = join(
  rootDir,
  "packages/core/src/ssr/sveltekit/appModules.fixture.ts",
);
const svelteProject = {
  plugins: [svelte({ configFile: false })],
  // The client build of Svelte, which can mount components.
  resolve: { conditions: ["browser"] },
  test: {
    name: "core-svelte",
    root: "packages/core",
    environment: "jsdom",
    include: svelteTests,
    alias: {
      "$app/environment": appModules,
      "$app/navigation": appModules,
    },
    server: { deps: { inline: ["convex-svelte"] } },
  },
};

// Single Vitest config for the whole monorepo (Vitest "projects"). Run from the
// repo root with `pnpm test`; target one package with `pnpm test --project <name>`.
export default defineConfig({
  test: { projects: [...projects, svelteProject] },
});
