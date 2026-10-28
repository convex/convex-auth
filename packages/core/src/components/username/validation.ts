import { Infer, v } from "convex/values";

// The component applies only the rules that are correct for all applications.
// Characters of all scripts are permitted: the component can be used in an
// international application. The maximum length is generous; it only keeps
// a username far below the size limits of a Convex document.
//
// The component rejects only usernames that are clearly malformed.
//
// An application that wants more strict rules (only letters and digits, a
// minimum length of 3, a list of reserved names, …) applies them before it
// calls `setUsername`.
export const MIN_USERNAME_LENGTH = 1;
export const MAX_USERNAME_LENGTH = 100;

/**
 * The user-facing errors for `setUsername`. An application can show these
 * errors to the end user. The `error` field is a machine-readable code and
 * the discriminant of the union.
 */
export const setUsernameUserError = v.union(
  v.object({
    error: v.literal("USERNAME_TOO_SHORT"),
    minimumLength: v.number(),
  }),
  v.object({
    error: v.literal("USERNAME_TOO_LONG"),
    maximumLength: v.number(),
  }),
  // The username starts or ends with a space or a different whitespace
  // character.
  v.object({ error: v.literal("USERNAME_HAS_SURROUNDING_WHITESPACE") }),
  // The username contains a character that is not permitted. See
  // `hasDisallowedCharacter` for the list.
  v.object({ error: v.literal("USERNAME_HAS_INVALID_CHARACTERS") }),
  // A different user already has this username.
  v.object({ error: v.literal("USERNAME_TAKEN") }),
);
export type SetUsernameUserError = Infer<typeof setUsernameUserError>;

// Characters that make the text direction or the position of the subsequent
// characters different. An attacker uses them to show a username that is not
// the username that the component stores. The list does not contain the
// zero-width joiner (U+200D) and the zero-width non-joiner (U+200C). These
// two characters are necessary to write some scripts correctly, and also to
// write emoji sequences.
const BIDI_AND_INVISIBLE_CONTROLS = new Set([
  0x061c, // arabic letter mark
  0x200b, // zero-width space
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // right-to-left override
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first strong isolate
  0x2069, // pop directional isolate
  0xfeff, // zero-width no-break space (byte order mark)
]);

// Whitespace characters that are not the ASCII space. Each one looks the
// same as a space, thus two usernames that a person cannot distinguish
// would be two different accounts. A space in the middle of a username
// stays permitted.
const NON_ASCII_WHITESPACE = new Set([
  0x00a0, // no-break space
  0x1680, // ogham space mark
  0x2000, // en quad
  0x2001, // em quad
  0x2002, // en space
  0x2003, // em space
  0x2004, // three-per-em space
  0x2005, // four-per-em space
  0x2006, // six-per-em space
  0x2007, // figure space
  0x2008, // punctuation space
  0x2009, // thin space
  0x200a, // hair space
  0x202f, // narrow no-break space
  0x205f, // medium mathematical space
  0x3000, // ideographic space
]);

/**
 * Tell if the code point is never permitted in a username.
 */
function isDisallowedCodePoint(codePoint: number): boolean {
  // The C0 controls and the tab, the line feed and the carriage return.
  if (codePoint <= 0x1f) {
    return true;
  }
  // The delete character and the C1 controls.
  if (codePoint >= 0x7f && codePoint <= 0x9f) {
    return true;
  }
  // An unpaired surrogate. The text is then not correct Unicode.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return true;
  }
  if (BIDI_AND_INVISIBLE_CONTROLS.has(codePoint)) {
    return true;
  }
  if (NON_ASCII_WHITESPACE.has(codePoint)) {
    return true;
  }
  // The noncharacters. These code points are permanently reserved, and
  // applications are not required to show them.
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) {
    return true;
  }
  // The last two code points of each plane (U+FFFE, U+FFFF, U+1FFFE, …).
  if ((codePoint & 0xfffe) === 0xfffe) {
    return true;
  }
  return false;
}

function hasDisallowedCharacter(username: string): boolean {
  // The `for … of` loop gives the code points, and not the UTF-16 units.
  for (const character of username) {
    if (isDisallowedCodePoint(character.codePointAt(0)!)) {
      return true;
    }
  }
  return false;
}

/**
 * Examine a username against the requirements. Return a
 * `SetUsernameUserError` for the first violation, or `null` when the
 * username is correct.
 */
export function validateUsernameFormat(
  username: string,
): SetUsernameUserError | null {
  // See the comment on the minimum length below for how the length is
  // measured.
  if (isTooLong(username)) {
    return { error: "USERNAME_TOO_LONG", maximumLength: MAX_USERNAME_LENGTH };
  }
  // Reject whitespace at the start and at the end. The `u` flag makes `\s`
  // match all Unicode whitespace. A comparison with `username.trim()` does
  // not find some of these characters.
  if (/^\s|\s$/u.test(username)) {
    return { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" };
  }
  if (hasDisallowedCharacter(username)) {
    return { error: "USERNAME_HAS_INVALID_CHARACTERS" };
  }
  // A combining mark at the first position shows on the character before
  // the username. An attacker uses this to change how a different text
  // shows, for example in a list of users.
  if (/^\p{M}/u.test(username)) {
    return { error: "USERNAME_HAS_INVALID_CHARACTERS" };
  }
  // The length is a count of Unicode code points (`[...username].length`)
  // and not of UTF-16 units. Thus a character outside the basic plane (an
  // emoji, for example) counts as one character. The length is measured
  // after normalization, because normalization can make the username
  // shorter.
  if ([...normalizeUsername(username)].length < MIN_USERNAME_LENGTH) {
    return { error: "USERNAME_TOO_SHORT", minimumLength: MIN_USERNAME_LENGTH };
  }
  return null;
}

/**
 * Tell if the username has more than {@link MAX_USERNAME_LENGTH} code
 * points after normalization. No stored username is that long, thus a lookup
 * can skip the database for such a username.
 */
export function isTooLong(username: string): boolean {
  return [...normalizeUsername(username)].length > MAX_USERNAME_LENGTH;
}

/**
 * Normalize a username for comparisons.
 *
 * The function first makes the username lowercase, so that usernames are
 * not case-sensitive. Then it applies NFC normalization, so that two
 * inputs that a user sees as the same but that use different Unicode
 * normalization forms compare as equal. The order is important: the
 * lowercase operation can make a string that is not in the NFC form.
 */
export function normalizeUsername(username: string): string {
  return username.toLowerCase().normalize("NFC");
}
