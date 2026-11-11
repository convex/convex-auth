// The type of a `.wasm` import with `vite-plugin-wasm-module`. Add
// `"vite-plugin-wasm-module/client"` to `compilerOptions.types` to use it.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
