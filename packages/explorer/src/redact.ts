/**
 * Keeps secrets out of a timeline.
 *
 * Documents: a field keeps its value only when it is known to be safe. The
 * rule, for each field of a document, nested objects included:
 *
 * 1. A field whose name ends in `Id` and whose value looks like a Convex id
 *    is kept.
 * 2. A field whose name looks like a secret (`hash`, `passwordHashPHC`,
 *    `secret`, `token`, `code`, `challenge`, `publicKey`, ...) is replaced by
 *    {@link REDACTED}, whatever its table.
 * 3. `_id` and `_creationTime` are kept.
 * 4. A field that {@link SAFE_FIELDS} lists for the table is kept.
 * 5. Otherwise a boolean, a number, or null is kept; an object or an array is
 *    checked field by field; a string, or anything else, is replaced.
 *
 * Thus a table that the recorder does not know shows its ids, flags, numbers,
 * and timestamps, and none of its strings.
 *
 * Text (log lines, errors, step details): {@link scrubText} replaces what
 * looks like a token, a hash, or a key.
 *
 * @module
 */
import { REDACTED } from "./events.ts";

const SECRET_NAME =
  /hash|secret|token|passw|phc|salt|verifier|challenge|credential|publickey|privatekey|apikey|signature|code|nonce|encrypted|cookie|otp|handle/i;

/**
 * The string fields of the tables of the Convex Auth components that hold no
 * secret, by table name. Each name is safe in every table of that name.
 */
export const SAFE_FIELDS: Record<string, readonly string[]> = {
  // core
  sessions: ["component"],
  refreshTokens: ["state"],
  // username
  usernames: ["username", "usernameNormalized"],
  // email
  verifiedEmails: ["email", "normalizedEmail"],
  challenges: ["email", "purpose", "kind"],
  // passkey
  passkeys: ["name", "transports"],
  // totp
  totpSecrets: ["status"],
  // OAuth providers
  accounts: ["providerName", "providerAccountId"],
  authorizationRequests: [
    "providerName",
    "redirectTo",
    "callbackUrl",
    "tokenEndpoint",
    "userInfoEndpoints",
    "issuers",
  ],
  tickets: ["providerName"],
  // the rate limiter of the password component
  rateLimits: ["name", "key"],
};

// Convex ids: 31 to 37 characters of lowercase base32.
const CONVEX_ID = /^[0-9a-z]{31,37}$/;
const ID_NAME = /(^id|Id|_id)$/;

function isConvexIdField(name: string, value: unknown): boolean {
  return (
    ID_NAME.test(name) && typeof value === "string" && CONVEX_ID.test(value)
  );
}

/** A copy of a document of `table` with secrets replaced. */
export function redactDocument(
  table: string,
  document: Record<string, unknown>,
): Record<string, unknown> {
  return redactObject(document, new Set(SAFE_FIELDS[table] ?? []));
}

function redactObject(
  object: Record<string, unknown>,
  safe: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(object)) {
    out[name] = redactField(name, value, safe);
  }
  return out;
}

function redactField(
  name: string,
  value: unknown,
  safe: ReadonlySet<string>,
): unknown {
  if (isConvexIdField(name, value)) {
    return value;
  }
  if (SECRET_NAME.test(name)) {
    return REDACTED;
  }
  if (name === "_id" || name === "_creationTime" || safe.has(name)) {
    return value;
  }
  return redactValue(name, value);
}

function redactValue(name: string, value: unknown): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return isConvexIdField(name, value) ? value : REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((element) => redactValue(name, element));
  }
  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>, new Set());
  }
  return REDACTED;
}

const SECRET_TEXT = [
  // JWTs
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
  // PHC strings, e.g. argon2id hashes
  /\$argon2[a-z]*\$[^\s'"]+/g,
  // Convex deploy and admin keys
  /\b(?:prod|dev|preview|project):[^\s|'"]+\|[A-Za-z0-9+/=_-]+/g,
  // long hex, e.g. SHA-256 hashes
  /\b[0-9a-fA-F]{32,}\b/g,
];

// Random tokens in base64 or base64url, such as refresh tokens (43
// characters). A run of 24 or more such characters is replaced when it mixes
// digits, lowercase, and uppercase, which random bytes almost always do and
// names almost never do. Convex ids are lowercase, thus they stay.
const RANDOM_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

function looksRandom(run: string): boolean {
  return /[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/** A copy of free text with what looks like a secret replaced. */
export function scrubText(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT) {
    out = out.replace(pattern, REDACTED);
  }
  return out.replace(RANDOM_RUN, (run) => (looksRandom(run) ? REDACTED : run));
}

/** {@link scrubText} applied to each string of a JSON value. */
export function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, scrubValue(inner)]),
    );
  }
  return value;
}
