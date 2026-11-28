/**
 * Where the play-by-play list comes to rest (`ui/listRest.ts`).
 */
import { describe, expect, test } from "vitest";
import { endSpace, restingTop, type Stop } from "../ui/listRest.ts";

// A section's heading (22 px), and under it ten lines of 35 px.
const HEADING = 22;
const stops: Stop[] = [
  { top: 0, bottom: HEADING, under: 0 },
  ...Array.from({ length: 10 }, (_, i) => ({
    top: HEADING + 35 * i,
    bottom: HEADING + 35 * (i + 1),
    under: HEADING,
  })),
];
const line = (i: number) => stops[i + 1];

describe("restingTop", () => {
  test("a line rests whole under the heading", () => {
    // 20 px into the fourth line: back to it or on to the fifth.
    expect(restingTop(35 * 3 + 20, 200, 1000, stops)).toBe(35 * 4);
    expect(restingTop(35 * 3 + 10, 200, 1000, stops)).toBe(35 * 3);
  });

  test("the line being played stays whole at the bottom edge", () => {
    // Its bottom 6 px under the edge: one line on.
    const lit = line(5);
    const current = lit.bottom + 6 - 200 - 6;
    const top = restingTop(current, 200, 1000, stops, lit);
    expect(lit.bottom - top).toBeLessThanOrEqual(200);
    expect(lit.top - top).toBeGreaterThanOrEqual(HEADING);
    expect(stops.map((s) => s.top - s.under)).toContain(top);
  });

  test("the line being played comes out from under the heading", () => {
    const lit = line(2);
    expect(restingTop(35 * 4, 200, 1000, stops, lit)).toBe(35 * 2);
  });

  test("a line taller than the list shows its top", () => {
    const lit = { top: 100, bottom: 400, under: HEADING };
    expect(restingTop(0, 200, 1000, [...stops, lit], lit)).toBe(100 - HEADING);
  });

  test("never past the end", () => {
    expect(restingTop(500, 200, 180, stops)).toBeLessThanOrEqual(180);
  });
});

describe("endSpace", () => {
  test("makes the end of the list a stop", () => {
    const content = HEADING + 35 * 10 + 6;
    const space = endSpace(content, 200, stops);
    const end = content + space - 200;
    expect(stops.map((s) => s.top - s.under)).toContain(end);
    expect(space).toBeLessThan(35);
  });

  test("none when the list fits", () => {
    expect(endSpace(150, 200, stops)).toBe(0);
  });
});
