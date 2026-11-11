# vite-plugin-wasm-module

A Vite plugin that loads each `.wasm` import as a
[`WebAssembly.Module`](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Module).
Use it to run code for Convex or Cloudflare Workers in Vitest or in the Vite
dev server.

## How a `.wasm` import loads

```ts
import wasmModule from "./module.wasm";

wasmModule instanceof WebAssembly.Module; // true

const instance = await WebAssembly.instantiate(wasmModule, {
  wbg: {/* the imports of the module */},
});
```

The default export is a compiled module. The plugin does not instantiate it
and does not resolve its imports. Your code instantiates the module and gives
the imports.

The [Convex](https://www.convex.dev) runtime and
[Cloudflare Workers](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
load a `.wasm` import the same way. Thus, code that runs in these runtimes
also runs in Vite with this plugin, without changes.

This is the same as the `web` target of `wasm-bindgen`, which gives its
imports when it instantiates the module:

```ts
import init from "./pkg/my_crate.js";
import wasmModule from "./pkg/my_crate_bg.wasm";

await init({ module_or_path: wasmModule });
```

### Other ways to load `.wasm` files

| Import                           | Gives                                                           | Where                                                                                       |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `import m from "x.wasm"`         | A `WebAssembly.Module`                                          | This plugin, Convex, Cloudflare Workers                                                     |
| `import * as m from "x.wasm"`    | The exports of an instance, with imports resolved as ES modules | [`vite-plugin-wasm`](https://github.com/Menci/vite-plugin-wasm), webpack `asyncWebAssembly` |
| `import init from "x.wasm?init"` | A function that instantiates the module                         | [Vite](https://vite.dev/guide/features.html#webassembly)                                    |

The second row follows the
[WebAssembly ES module integration proposal](https://github.com/WebAssembly/esm-integration).
It resolves each import of the module as a package. Thus it fails with the
output of the `web` target of `wasm-bindgen`, whose imports (for example
`wbg`) are not packages.

The plugin does not change an import with a query, such as `x.wasm?init` or
`x.wasm?url`. Vite handles these imports.

## Installation

```sh
npm install --save-dev vite-plugin-wasm-module
```

## Usage with Vitest

```ts
import { defineConfig } from "vitest/config";
import wasmModule from "vite-plugin-wasm-module";

export default defineConfig({
  plugins: [wasmModule()],
  test: {
    server: {
      deps: {
        // The packages that import `.wasm` files.
        inline: ["my-wasm-package"],
      },
    },
  },
});
```

Vitest gives the files of most dependencies directly to Node, and Vite
plugins do not see their imports. If a dependency imports a `.wasm` file, add
the dependency to `test.server.deps.inline`. Then Vitest sends its imports
through the plugins.

## Usage with the Vite dev server

```ts
import { defineConfig } from "vite";
import wasmModule from "vite-plugin-wasm-module";

export default defineConfig({
  plugins: [wasmModule()],
});
```

The plugin applies only when Vite serves the code: in the dev server and in
Vitest. It does not change `vite build`. It inlines the bytes of each `.wasm`
file as base64 in the JavaScript, which is good for tests but makes a large
bundle.

## TypeScript

Add a reference to the type of `.wasm` imports in a declaration file of your
project, for example `src/env.d.ts`:

```ts
/// <reference types="vite-plugin-wasm-module/client" />
```

Or add it to `compilerOptions.types` of your `tsconfig.json`. This list
replaces the types that TypeScript includes automatically, thus keep the
entries that you already have:

```json
{
  "compilerOptions": {
    "types": ["node", "vite/client", "vite-plugin-wasm-module/client"]
  }
}
```

Or add a declaration file:

```ts
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
```
