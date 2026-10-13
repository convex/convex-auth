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
