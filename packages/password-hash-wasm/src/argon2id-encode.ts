import init, {
  encode_phc,
} from "../rust/pkg/argon2id-encode/argon2id-encode.js";
import wasmModule from "../rust/pkg/argon2id-encode/argon2id-encode_bg.wasm";
import { lazyInit } from "./init.ts";

const ensureReady = lazyInit("argon2id-encode", init, wasmModule);

/**
 * Encode an argon2id hash as a PHC string:
 * `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<salt>$<hash>`. It does not run argon2.
 *
 * Use it to import the argon2id hashes of another system. Only version 0x13
 * (19) of argon2 is supported.
 *
 * @param options.m The memory size, in KiB.
 * @param options.t The number of iterations.
 * @param options.p The degree of parallelism.
 * @param options.salt Between 4 and 48 bytes.
 * @param options.hash The derived key, between 10 and 64 bytes.
 * @throws If argon2 does not accept the parameters, or if the salt or the hash
 * has a length that is not valid.
 */
export async function encodePHC(options: {
  m: number;
  t: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
}): Promise<string> {
  await ensureReady();
  const { m, t, p, salt, hash } = options;
  try {
    return encode_phc(m, t, p, salt, hash);
  } catch (cause) {
    throw new Error(`Failed to encode the argon2id hash: ${cause}`, { cause });
  }
}
