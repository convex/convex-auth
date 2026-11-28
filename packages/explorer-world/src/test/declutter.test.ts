/**
 * The boxes the declutter pass keeps apart: two names shown never touch,
 * and a name not yet laid out is not taken for narrower than it is.
 */
import { describe, expect, test } from "vitest";
import { CHAR_EM, GAP, nameBox, overlapsAny } from "../scene/declutter.ts";

/** The box of a name of `em` font sizes at `px` pixels, its left end at `x`. */
const at = (x: number, em: number, px = 20) =>
  nameBox(x + (em * px) / 2, 100, px, em, 1);

describe("names on screen", () => {
  test("two names whose text just touches overlap, so one gives way", () => {
    // "anonymous" ending where "github" starts read as one word.
    const anonymous = at(0, 5.73);
    const github = at(5.73 * 20, 3.2);
    expect(overlapsAny(github, [anonymous])).toBe(true);
  });

  test("names closer than the gap overlap; names the gap apart do not", () => {
    const left = at(0, 4);
    expect(overlapsAny(at(80 + GAP - 1, 4), [left])).toBe(true);
    expect(overlapsAny(at(80 + GAP, 4), [left])).toBe(false);
  });

  test("a name under another keeps the gap too", () => {
    const top = nameBox(100, 100, 20, 4, 1);
    // Its text from 12 below the first line's middle; the first ends at 12.
    expect(overlapsAny(nameBox(100, 124 + GAP - 1, 20, 4, 1), [top])).toBe(
      true,
    );
    expect(overlapsAny(nameBox(100, 124 + GAP, 20, 4, 1), [top])).toBe(false);
  });

  test("before its text is laid out, a bold name is not taken for narrower", () => {
    // Measured on the bold font: "anonymous" is 0.637 font sizes a character.
    expect(CHAR_EM).toBeGreaterThanOrEqual(0.637);
  });
});
