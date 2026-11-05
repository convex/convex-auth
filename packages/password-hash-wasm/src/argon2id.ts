import init, {
  hash_password,
  verify_password,
} from "../rust/pkg/argon2id/argon2id.js";
import wasmModule from "../rust/pkg/argon2id/argon2id_bg.wasm";
import { lazyInit } from "./init.ts";

const ensureReady = lazyInit("argon2id", init, wasmModule);

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
