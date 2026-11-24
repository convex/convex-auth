/**
 * Crypto helpers shared across the core and the optional components.
 *
 * @module
 */

/**
 * SHA-256 hex digest. Used wherever a secret (refresh token, OAuth state,
 * ticket code) must be looked up later without persisting the raw value.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Cryptographically random 256-bit opaque token, base64url encoded. Used for
 * the tokens that a challenge or a ticket hands out and later hashes.
 */
export function generateRandomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** The number of digits in a short code. */
export const SHORT_CODE_DIGITS = 8;

/**
 * Cryptographically random short code of `SHORT_CODE_DIGITS` decimal digits,
 * for example `"04718295"`. It has about 26.6 bits of entropy, thus the code
 * that verifies it must limit the attempts.
 *
 * The function takes 27 random bits and rejects the values at or above
 * 10^8. Thus each code has the same probability (no modulo bias).
 */
export function generateShortCode(): string {
  const limit = 10 ** SHORT_CODE_DIGITS;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]! & 0x07ff_ffff; // 27 bits: 0 to 134,217,727
    if (value < limit) {
      return value.toString().padStart(SHORT_CODE_DIGITS, "0");
    }
  }
}
