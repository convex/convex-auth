/**
 * base64url encoding of the binary fields of the WebAuthn wire.
 *
 * @module
 */

/**
 * Encode bytes as an unpadded base64url string, the form that every binary
 * field of the WebAuthn JSON wire takes.
 */
export function toBase64URL(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode an unpadded base64url string back to bytes. The browser client
 * needs it: the WebAuthn API takes the challenge and the credential IDs as
 * `BufferSource`, while the wire carries them as base64url.
 */
export function fromBase64URL(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  // `atob` needs the padding that the wire leaves out.
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
