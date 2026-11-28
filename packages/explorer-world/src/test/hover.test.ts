/**
 * The hover line of a shape that can go away under the pointer: it goes
 * with the shape, and never takes away a line some other shape set since.
 */
import { describe, expect, test } from "vitest";
import { hover, hoverFrom, hoverGone } from "../hover.ts";

describe("the hover line of an open part", () => {
  test("goes when the part closes under the pointer", () => {
    hoverFrom("inside:a", "AuthClient · class");
    expect(hover.label).toBe("AuthClient · class");
    // Closed with no pointerout: the part takes its line back.
    hoverGone("inside:a");
    expect(hover.label).toBe("");
  });

  test("stays when another shape set the line since", () => {
    hoverFrom("inside:a", "AuthClient · class");
    hover.label = "session core · 4 parts";
    hoverGone("inside:a");
    expect(hover.label).toBe("session core · 4 parts");
  });

  test("is not taken by a part that set none", () => {
    hover.label = "session core · 4 parts";
    hoverGone("inside:b");
    expect(hover.label).toBe("session core · 4 parts");
  });
});
