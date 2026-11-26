import { describe, expect, test } from "vitest";
import { nanosOf, nanosToMs, parseJsonLossless } from "./json.ts";

describe("parseJsonLossless", () => {
  test("keeps the digits of an integer above 2^53 as a string", () => {
    expect(
      parseJsonLossless('{"ts":1795729719942017883,"n":[-9007199254740993]}'),
    ).toEqual({ ts: "1795729719942017883", n: ["-9007199254740993"] });
  });

  test("leaves safe numbers, floats, and strings as they are", () => {
    expect(
      parseJsonLossless(
        '{"a":1795729720655,"b":1795729719866.0613,"c":"1795729719942017883","d":"x\\"1795729719942017883"}',
      ),
    ).toEqual({
      a: 1795729720655,
      b: 1795729719866.0613,
      c: "1795729719942017883",
      d: 'x"1795729719942017883',
    });
  });
});

describe("nanosToMs", () => {
  test("converts nanoseconds to milliseconds", () => {
    expect(nanosToMs("1795729719942017883")).toBeCloseTo(1795729719942.018, 3);
  });
});

describe("nanosOf", () => {
  test("accepts a decimal string or a safe integer", () => {
    expect(nanosOf("1795729719942017883")).toBe("1795729719942017883");
    expect(nanosOf(12)).toBe("12");
    expect(nanosOf(1.5)).toBeNull();
    expect(nanosOf("abc")).toBeNull();
  });
});
