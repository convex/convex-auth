/// <reference types="vitest/config" />
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

// The packages that Vitest must transform instead of handing to Node.
// `convex-test` loads the modules of the functions dynamically, and it needs
// the transform for that. `argon2id-wasm` imports a `.wasm` file: if Vitest
// externalizes the package, Node loads that file as a WebAssembly ES module,
// tries to resolve the wasm-bindgen import `wbg` as an npm package, and fails
// with "Cannot find package 'wbg'". Inlining it sends the import through
// `load` below.
const INLINE = ["convex-test", "argon2id-wasm"];

/**
 * A Vitest plugin that runs Convex Auth under `convex-test`.
 *
 * Add it to the Vitest config of the app:
 *
 * ```ts
 * import { defineConfig } from "vitest/config";
 * import { convexAuthTest } from "@convex-dev/auth/test/vitest";
 *
 * export default defineConfig({
 *   plugins: [convexAuthTest()],
 *   test: { environment: "edge-runtime" },
 * });
 * ```
 *
 * It loads each `.wasm` import as the default export of a
 * `WebAssembly.Module`, the same as the bundler of the Convex CLI, and it
 * adds `convex-test` and `argon2id-wasm` to `test.server.deps.inline`. The
 * password component hashes with `argon2id-wasm`, so without the plugin, each
 * test that hashes a password fails.
 */
export function convexAuthTest(): Plugin {
  return {
    name: "convex-auth-test",
    // Runs before the `.wasm` handling of Vite, which would otherwise try to
    // resolve the wasm-bindgen imports as modules and fail the same way.
    enforce: "pre",
    config(config) {
      const inline = config.test?.server?.deps?.inline;
      // `true` already inlines every dependency.
      if (inline === true) return;
      // Vite concatenates arrays when it merges this into the config of the
      // app, so the entries of the app stay.
      return { test: { server: { deps: { inline: INLINE } } } };
    },
    async load(id) {
      if (!id.endsWith(".wasm")) return null;
      const base64 = (await readFile(id)).toString("base64");
      return [
        `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));`,
        "export default new WebAssembly.Module(bytes);",
      ].join("\n");
    },
  };
}
