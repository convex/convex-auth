/**
 * `JSON.parse` loses the digits of an integer above 2^53, and the data sync
 * gives commit times in nanoseconds, around 1.8e18. This parser keeps each
 * such integer as a decimal string.
 *
 * It quotes the integer literals outside of strings that are not safe
 * integers, then calls `JSON.parse`. An unsafe integer inside a document
 * becomes a string too, which keeps its digits.
 */
export function parseJsonLossless(text: string): unknown {
  let out = "";
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        i += text[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      let end = i + 1;
      while (end < text.length && /[0-9eE.+-]/.test(text[end])) {
        end++;
      }
      const literal = text.slice(i, end);
      if (/^-?\d+$/.test(literal) && !Number.isSafeInteger(Number(literal))) {
        out += text.slice(start, i) + '"' + literal + '"';
        start = end;
      }
      i = end;
      continue;
    }
    i++;
  }
  return JSON.parse(out + text.slice(start));
}

/**
 * A nanosecond time as a decimal string. Accepts what
 * {@link parseJsonLossless} gives: a string, or a number when the value was
 * small enough.
 */
export function nanosOf(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

/** Nanoseconds, as a decimal string, to milliseconds. */
export function nanosToMs(nanos: string): number {
  const big = BigInt(nanos);
  return Number(big / 1_000_000n) + Number(big % 1_000_000n) / 1_000_000;
}
