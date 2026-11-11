// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import wasmModule from "./index.ts";

// A module that imports the function `f` from the module `wbg`, as the
// output of wasm-bindgen does. If the plugin resolved the imports of the
// module, `wbg` would fail to resolve.
const WASM_WITH_IMPORT = new Uint8Array([
  // Magic number and version.
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // Type section: one function type, no parameters, no results.
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  // Import section: function `f` of type 0 from module `wbg`.
  0x02, 0x09, 0x01, 0x03, 0x77, 0x62, 0x67, 0x01, 0x66, 0x00, 0x00,
]);

let dir: string;
let server: ViteDevServer;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vite-plugin-wasm-module-"));
  await writeFile(join(dir, "module.wasm"), WASM_WITH_IMPORT);
  await writeFile(
    join(dir, "entry.js"),
    'export { default } from "./module.wasm";\n',
  );
  await writeFile(join(dir, "value.js"), "export const value = 42;\n");
  server = await createServer({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [wasmModule()],
    server: { middlewareMode: true, ws: false },
  });
});

afterAll(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

test("the default export of a .wasm import is a WebAssembly.Module", async () => {
  const { default: module } = await server.ssrLoadModule("/entry.js");
  expect(module).toBeInstanceOf(WebAssembly.Module);
  expect(WebAssembly.Module.imports(module)).toEqual([
    { module: "wbg", name: "f", kind: "function" },
  ]);
});

test("the module instantiates with the imports of the caller", async () => {
  const { default: module } = await server.ssrLoadModule("/module.wasm");
  const instance = await WebAssembly.instantiate(module, {
    wbg: { f: () => {} },
  });
  expect(instance).toBeInstanceOf(WebAssembly.Instance);
});

test("Vite loads an id whose query ends with .wasm", async () => {
  const { value } = await server.ssrLoadModule("/value.js?from=module.wasm");
  expect(value).toBe(42);
});

test("Vite loads a .wasm import with a query", async () => {
  const { default: url } = await server.ssrLoadModule("/module.wasm?url");
  expect(url).toMatch(/\/module\.wasm$/);
});

test("the plugin applies only when Vite serves the code", () => {
  expect(wasmModule().apply).toBe("serve");
});
