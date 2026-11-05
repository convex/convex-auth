/**
 * Returns a function that instantiates a wasm-bindgen module once. The
 * exports of the module can be called only after the instantiation.
 *
 * The function memoizes the promise, so concurrent calls share a single
 * instantiation. (The callers don't do concurrent WASM calls at the moment, but
 * it's still safer to do so.)
 */
export function lazyInit(
  name: string,
  init: (options: { module_or_path: WebAssembly.Module }) => Promise<unknown>,
  module: WebAssembly.Module,
): () => Promise<unknown> {
  let ready: Promise<unknown> | null = null;
  return () => {
    if (!ready) {
      ready = init({ module_or_path: module }).catch((cause: unknown) => {
        // Reset so a later call can retry, and surface a clear error instead
        // of the raw wasm-bindgen failure.
        ready = null;
        throw new Error(
          `Failed to initialize the ${name} WASM module: ${cause}`,
          {
            cause,
          },
        );
      });
    }
    return ready;
  };
}
