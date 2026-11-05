import { describe, expect, test } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  validatePasswordInputFormat,
} from "./validation.ts";

describe("minimumLength", () => {
  test("rejects a password that is shorter than minimumLength", () => {
    expect(validatePasswordInputFormat("kY7t-vQ2m", 10)).toEqual({
      error: "PASSWORD_TOO_SHORT",
      minimumLength: 10,
    });
    expect(validatePasswordInputFormat("kY7t-vQ2m", MIN_PASSWORD_LENGTH)).toBe(
      null,
    );
  });

  test.each([
    ["less than MIN_PASSWORD_LENGTH", MIN_PASSWORD_LENGTH - 1],
    ["0", 0],
    ["NaN", NaN],
  ])("throws when minimumLength is %s", (_, minimumLength) => {
    expect(() =>
      validatePasswordInputFormat("kY7t-vQ2m", minimumLength),
    ).toThrow("minimumLength must be 8 or more");
    expect(() => validateNewPassword("kY7t-vQ2m", minimumLength)).toThrow(
      "minimumLength must be 8 or more",
    );
  });
});
