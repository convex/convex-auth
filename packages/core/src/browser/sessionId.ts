/**
 * Reads which session an access token belongs to. The token's subject (`sub`)
 * is the id of its session.
 *
 * The client only needs to notice when it moves from one session to another,
 * so this decodes the token without verifying it (the Convex backend verifies
 * it). It does not use `jose`, which the server code uses for the same
 * purpose: its decoder needs `TextDecoder` and `atob`, which some React Native
 * runtimes lack.
 *
 * @module
 */

/**
 * The session id of a token that cannot be read. Every unreadable token gets
 * this same id, so the client treats two of them as one session, which is how
 * it treated every token before it tracked the session.
 */
export const UNREADABLE_SESSION_ID = "unreadable";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode base64url text to a string with one character per byte. A session id
 * is ASCII, so this reads it exactly. Other claims with characters outside
 * ASCII come out garbled, which `JSON.parse` still accepts.
 */
function base64UrlBytesAsText(encoded: string): string {
  let text = "";
  let bits = 0;
  let bitCount = 0;
  for (const character of encoded) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value === -1) {
      throw new Error("Not base64url text.");
    }
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      text += String.fromCharCode((bits >> bitCount) & 0xff);
    }
  }
  return text;
}

/**
 * The id of the session that an access token belongs to, or
 * {@link UNREADABLE_SESSION_ID} for a token that cannot be read.
 */
export function sessionIdOfAccessToken(accessToken: string): string {
  try {
    const [, payload] = accessToken.split(".");
    const claims: unknown = JSON.parse(base64UrlBytesAsText(payload));
    const subject = (claims as { sub?: unknown }).sub;
    return typeof subject === "string" ? subject : UNREADABLE_SESSION_ID;
  } catch {
    return UNREADABLE_SESSION_ID;
  }
}
