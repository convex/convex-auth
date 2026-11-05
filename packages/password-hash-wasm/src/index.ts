import init, {
  hash_password,
  verify_password,
} from "../rust/pkg/argon2_wasm.js";
import wasmModule from "../rust/pkg/argon2_wasm_bg.wasm";

// The wasm-bindgen module must be instantiated once before its exports can be
// called. Memoize the promise so concurrent calls share a single init.
//
// (This component doesn’t do concurrent WASM calls at the moment, but it’s still safer to do so.)
let ready: Promise<unknown> | null = null;
function ensureReady() {
  if (!ready) {
    ready = init({ module_or_path: wasmModule }).catch((cause: unknown) => {
      // Reset so a later call can retry, and surface a clear error instead of
      // the raw wasm-bindgen failure.
      ready = null;
      throw new Error(`Failed to initialize the argon2 WASM module: ${cause}`, {
        cause,
      });
    });
  }
  return ready;
}

/** Hash a password with argon2id, returning a PHC string (salt + params embedded). */
export async function hashPassword(password: string): Promise<string> {
  await ensureReady();
  const salt = crypto.getRandomValues(new Uint8Array(16)); // randomness stays in JS
  try {
    return hash_password(password, salt);
  } catch (cause) {
    // Hashing shouldn't fail for a valid input; surface a clear error instead
    // of the raw wasm-bindgen failure.
    throw new Error(`Failed to hash password: ${cause}`, { cause });
  }
}

/** Verify a password against a stored PHC string. */
export async function verifyPassword(
  password: string,
  phc: string,
): Promise<boolean> {
  await ensureReady();
  try {
    return verify_password(password, phc);
  } catch (cause) {
    // Thrown when the stored PHC string can't be parsed as an argon2 hash (it's
    // always our own data, so this is unrecoverable). Surface a clear error
    // instead of the raw wasm-bindgen failure.
    throw new Error(
      `Failed to verify password against the stored hash: ${cause}`,
      {
        cause,
      },
    );
  }
}
