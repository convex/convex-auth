import init, { encode_phc } from "../rust/pkg/scrypt-encode/scrypt-encode.js";
import wasmModule from "../rust/pkg/scrypt-encode/scrypt-encode_bg.wasm";
import { lazyInit } from "./init.ts";

const ensureReady = lazyInit("scrypt-encode", init, wasmModule);

/**
 * Encode a scrypt hash as a PHC string:
 * `$scrypt$ln=<ln>,r=<r>,p=<p>$<salt>$<hash>`. It does not run scrypt.
 *
 * Use it to import the scrypt hashes of another system. For example, a hash
 * of lucia `Scrypt` is `<salt>:<hex key>`: its salt is the UTF-8 bytes of
 * `<salt>` (not the decoded hex), its hash is the decoded `<hex key>`, and
 * `ln = 14`, `r = 16`, `p = 1`.
 *
 * `password-hash-wasm/scrypt` verifies the result if the parameters are in
 * its limits.
 *
 * @param options.ln The log2 of the scrypt parameter `N`.
 * @param options.salt Between 4 and 48 bytes.
 * @param options.hash The derived key, between 10 and 64 bytes.
 * @throws If scrypt does not accept the parameters, or if the salt or the hash
 * has a length that is not valid.
 */
export async function encodePHC(options: {
  ln: number;
  r: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
}): Promise<string> {
  await ensureReady();
  const { ln, r, p, salt, hash } = options;
  try {
    return encode_phc(ln, r, p, salt, hash);
  } catch (cause) {
    throw new Error(`Failed to encode the scrypt hash: ${cause}`, { cause });
  }
}
