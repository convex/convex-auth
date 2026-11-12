import { anyApi, componentsGeneric } from "convex/server";
import { describe, expect, test } from "vitest";
import { componentPathOf } from "./componentPath.ts";

describe("componentPathOf", () => {
  const components = componentsGeneric() as unknown as Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;

  test("returns the path of a component that the app mounts", () => {
    expect(componentPathOf(components.authPassword)).toBe("authPassword");
  });

  test("returns the full path of a nested component", () => {
    expect(componentPathOf(components.authPassword.inner)).toBe(
      "authPassword/inner",
    );
  });

  // The reference only says that it points inside a child component, so a
  // function of the component isn't told apart from the component itself.
  test("returns the reference path of a function of a component", () => {
    expect(componentPathOf(components.authPassword.public.signIn)).toBe(
      "authPassword/public/signIn",
    );
  });

  test("refuses a reference to a function of the app", () => {
    expect(() => componentPathOf(anyApi.users.get)).toThrow(
      "Expected a reference inside a component",
    );
  });

  test("refuses the `components` object itself", () => {
    expect(() => componentPathOf(components)).toThrow(
      "Expected a reference inside a component",
    );
  });

  test("refuses something that is not a reference", () => {
    expect(() => componentPathOf({})).toThrow(
      "Expected a reference inside a component",
    );
  });
});
