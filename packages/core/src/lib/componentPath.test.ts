import { componentsGeneric } from "convex/server";
import { describe, expect, test } from "vitest";
import { componentPathOf } from "./componentPath.ts";

describe("componentPathOf", () => {
  const components = componentsGeneric() as unknown as Record<
    string,
    Record<string, unknown>
  >;

  test("returns the path of a component that the app mounts", () => {
    expect(componentPathOf(components.authPassword)).toBe("authPassword");
  });

  test("refuses something that is not the reference of a component", () => {
    expect(() => componentPathOf({})).toThrow(
      "Expected the reference of a component",
    );
  });
});
