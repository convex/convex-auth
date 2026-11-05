import { scrypt } from "@noble/hashes/scrypt.js";

// Support for scrypt password hashes that come from other systems, such as
// Convex Auth v1: a migration writes them in the `passwords` table. The
// component does not make new scrypt hashes, it only verifies them. When the
// user sets a new password, `setPassword` stores an argon2id hash.
//
// The component stores a scrypt hash as a PHC string in the form of passlib
// and `@phc/scrypt`:
//
//   $scrypt$ln=<log2(N)>,r=<r>,p=<p>$<salt>$<hash>
//
// The salt and the hash use the PHC "B64" encoding: standard base64 with no
// padding.

// Limits for an imported scrypt hash. They keep one verification inside the
// memory and time limits of a Convex mutation. The memory of scrypt is
// 128 * r * (N + p) bytes: 32 MiB with the v1 parameters.
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;
const MAX_LN = 20;
const MAX_R = 32;
const MAX_P = 16;
const MIN_SALT_LENGTH = 8;
const MAX_SALT_LENGTH = 64;
const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 128;

type ScryptPHC = {
  ln: number;
  r: number;
  p: number;
  salt: Uint8Array;
  hash: Uint8Array;
};

function formatScryptPHC({ ln, r, p, salt, hash }: ScryptPHC): string {
  return `$scrypt$ln=${ln},r=${r},p=${p}$${encodeB64(salt)}$${encodeB64(hash)}`;
}

/**
 * Returns true when the PHC string identifies the scrypt algorithm. It does not
 * validate the rest of the string: use {@link parseScryptPHC} for that.
 */
export function isScryptPHC(phc: string): boolean {
  return phc.startsWith("$scrypt$");
}

/**
 * Parse a scrypt PHC string. Returns `null` when the string is not a valid
 * scrypt PHC string or when its parameters are out of the supported limits.
 */
export function parseScryptPHC(phc: string): ScryptPHC | null {
  const match =
    /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      phc,
    );
  if (match === null) {
    return null;
  }
  const ln = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (ln < 1 || ln > MAX_LN || r < 1 || r > MAX_R || p < 1 || p > MAX_P) {
    return null;
  }
  if (128 * r * (2 ** ln + p) > MAX_SCRYPT_MEMORY) {
    return null;
  }
  const salt = decodeB64(match[4]);
  const hash = decodeB64(match[5]);
  if (salt === null || hash === null) {
    return null;
  }
  if (salt.length < MIN_SALT_LENGTH || salt.length > MAX_SALT_LENGTH) {
    return null;
  }
  if (hash.length < MIN_KEY_LENGTH || hash.length > MAX_KEY_LENGTH) {
    return null;
  }
  // Reject a non-canonical encoding, so that one hash has one PHC string.
  if (formatScryptPHC({ ln, r, p, salt, hash }) !== phc) {
    return null;
  }
  return { ln, r, p, salt, hash };
}

/**
 * Verify a password against a scrypt PHC string.
 *
 * The password is normalized to NFKC before hashing, as lucia `Scrypt` does.
 * Give the password as the user typed it.
 *
 * @throws If `phc` is not a valid scrypt PHC string.
 */
export function verifyScryptPHC(password: string, phc: string): boolean {
  const parsed = parseScryptPHC(phc);
  if (parsed === null) {
    throw new Error("The stored password hash is not a valid scrypt hash.");
  }
  // Use the synchronous function: `scryptAsync` uses `setTimeout`, which a
  // Convex mutation cannot use.
  const key = scrypt(password.normalize("NFKC"), parsed.salt, {
    N: 2 ** parsed.ln,
    r: parsed.r,
    p: parsed.p,
    dkLen: parsed.hash.length,
    // noble also counts one scratch block of 128 * r bytes.
    maxmem: MAX_SCRYPT_MEMORY + 128 * parsed.r,
  });
  return constantTimeEqual(key, parsed.hash);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function encodeB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/, "");
}

function decodeB64(b64: string): Uint8Array | null {
  // One character of B64 holds 6 bits: a length of 1 (mod 4) is not valid.
  if (b64.length % 4 === 1) {
    return null;
  }
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
