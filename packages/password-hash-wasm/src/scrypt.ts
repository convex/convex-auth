import init, { verify_password } from "../rust/pkg/scrypt/scrypt.js";
import wasmModule from "../rust/pkg/scrypt/scrypt_bg.wasm";
import { lazyInit } from "./init.ts";

const ensureReady = lazyInit("scrypt", init, wasmModule);

/**
 * Verify a password against a scrypt PHC string:
 * `$scrypt$ln=<log2(N)>,r=<r>,p=<p>$<salt>$<hash>`.
 *
 * The password is hashed as given (UTF-8). If the hash was made from a
 * normalized password, normalize the password the same way before the call.
 *
 * To keep one verification inside the memory and time limits of a Convex
 * mutation, the parameters must be in these limits: `ln ≥ 1`, memory
 * `128 · r · (N + p)` at most 33 MiB, and work `N · r · p` at most 2^19. The
 * parameters of Convex Auth v1 (`ln = 14`, `r = 16`, `p = 1`) use 32 MiB and a
 * work of 2^18.
 *
 * @throws If `phc` is not a valid scrypt PHC string, or if its parameters are
 * out of the limits.
 */
export async function verifyPassword(
  password: string,
  phc: string,
): Promise<boolean> {
  await ensureReady();
  try {
    return verify_password(password, phc);
  } catch (cause) {
    throw new Error(
      `Failed to verify password against the stored hash: ${cause}`,
      { cause },
    );
  }
}
