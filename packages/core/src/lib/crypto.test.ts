import { describe, expect, test } from "vitest";
import { generateNumericCode } from "./crypto.ts";

describe("generateNumericCode", () => {
  test.each([1, 6, 8, 10, 64])("gives %i digits", (length) => {
    expect(generateNumericCode(length)).toMatch(new RegExp(`^\\d{${length}}$`));
  });

  test("uses every digit", () => {
    const digits = new Set(generateNumericCode(1000));
    expect(digits.size).toBe(10);
  });

  test.each([0, -1, 2.5, Number.NaN])("throws for a length of %s", (length) => {
    expect(() => generateNumericCode(length)).toThrow(
      /must be a positive integer/,
    );
  });
});
