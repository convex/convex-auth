import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

/**
 * A Vite plugin that loads each `.wasm` import as a `WebAssembly.Module`.
 *
 * ```ts
 * import wasmModule from "./module.wasm";
 *
 * const instance = await WebAssembly.instantiate(wasmModule, imports);
 * ```
 *
 * The default export is a compiled module. The plugin does not instantiate
 * it and does not resolve its imports. Convex and Cloudflare Workers load a
 * `.wasm` import the same way.
 *
 * The plugin applies only when Vite serves the code: in the dev server and in
 * Vitest. It does not change `vite build`.
 */
export default function wasmModule(): Plugin {
  return {
    name: "vite-plugin-wasm-module",
    apply: "serve",
    // Runs before the `.wasm` handling of Vite. Vite does not support a plain
    // `.wasm` import, and it reports an error.
    enforce: "pre",
    async load(id) {
      // An id with a query, such as `x.wasm?init` or `x.wasm?url`, does not
      // end with `.wasm`. Vite handles these ids.
      if (!id.endsWith(".wasm")) return null;
      const base64 = (await readFile(id)).toString("base64");
      return [
        `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));`,
        "export default new WebAssembly.Module(bytes);",
      ].join("\n");
    },
  };
}
