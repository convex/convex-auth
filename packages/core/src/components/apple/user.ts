/**
 * The `user` field Apple posts to the callback.
 *
 * Everything else about the sign-in reaches us over TLS from Apple's own
 * servers. This one does not: Apple never sees the name the person types
 * into the system sign-in sheet, so the browser relays it to the callback
 * instead, and it arrives only on the very first authorization. Treat it as
 * user-controlled input, which is what Apple's docs say to do.
 *
 * @module
 */

/**
 * Longest first or last name kept. Anything longer is dropped as we
 * assume this is not an actual name and shenanigans are afoot.
 */
const MAX_NAME_LENGTH = 256;

/** Only the name parts are returned after sanitizing. */
export type SanitizedAppleUser = {
  name: {
    firstName?: string;
    lastName?: string;
  };
};

/** A name part, or undefined when it isn't a usable string. */
function namePart(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_NAME_LENGTH) {
    return undefined;
  }
  return trimmed;
}

/**
 * Read the name out of Apple's `user` form field, dropping everything else.
 *
 * Apple documents the field as
 * `{ "name": { "firstName": string, "lastName": string }, "email": string }`,
 * but since the browser is what posts it, none of that is guaranteed.
 * Returns undefined when the field is absent, unparseable, shaped wrong, or
 * carries no usable name.
 *
 * The email is deliberately ignored. When the email scope was granted, Apple
 * puts the address in the id_token, so the copy here is redundant, and being
 * browser-relayed it is untrusted either way.
 */
export function sanitizeAppleUser(
  raw: string | null,
): SanitizedAppleUser | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== "object" || name === null) {
    return undefined;
  }
  return sanitizeAppleName(name as { firstName?: unknown; lastName?: unknown });
}

/**
 * Keep the usable parts of a name. A native app gets the name from the
 * system sheet and passes it on, so it is user-controlled input too.
 * Returns undefined when neither part is usable.
 */
export function sanitizeAppleName(name: {
  firstName?: unknown;
  lastName?: unknown;
}): SanitizedAppleUser | undefined {
  const firstName = namePart(name.firstName);
  const lastName = namePart(name.lastName);
  if (firstName === undefined && lastName === undefined) {
    return undefined;
  }
  return { name: { firstName, lastName } };
}
