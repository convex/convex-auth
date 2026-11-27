import { describe, expect, test } from "vitest";
import { ERROR_CODES, KINDS, STATUSES } from "./signInSteps.ts";

// The server-side sources of the library: what its functions can return.
const sources: Record<string, string> = import.meta.glob(
  [
    "../methods/**/*.{ts,tsx}",
    "../components/**/*.{ts,tsx}",
    "../lib/**/*.{ts,tsx}",
    "../server/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
    "!**/*.fixture.ts",
    "!**/_generated/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** The values that `pattern` captures in the sources. */
function defined(...patterns: RegExp[]): string[] {
  const values = new Set<string>();
  for (const [path, source] of Object.entries(sources)) {
    // Client code does not return the results of sign-in functions.
    if (/^["']use client["']/m.test(source) || path.endsWith("/client.ts")) {
      continue;
    }
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) values.add(match[1]);
    }
  }
  return [...values].sort();
}

describe("the outcome lists of the sign-in reports", () => {
  test("read the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
  });

  test("hold every status the library defines", () => {
    const statuses = defined(/\bstatus:\s*(?:v\.literal\()?"([A-Za-z]+)"/g);
    expect(statuses).toContain("complete");
    expect(statuses.filter((value) => !STATUSES.has(value))).toEqual([]);
  });

  test("hold every kind the library defines", () => {
    const kinds = defined(/\bkind:\s*(?:v\.literal\()?"([A-Za-z]+)"/g);
    expect(kinds).toContain("resend");
    expect(kinds.filter((value) => !KINDS.has(value))).toEqual([]);
  });

  test("hold every error code the library defines", () => {
    const codes = defined(
      /\berror:\s*(?:v\.literal\()?"([A-Z][A-Z0-9_]+)"/g,
      /literal\("([A-Z][A-Z0-9_]+)"\)/g,
    );
    expect(codes).toContain("INVALID_CREDENTIALS");
    expect(codes.filter((value) => !ERROR_CODES.has(value))).toEqual([]);
  });
});
