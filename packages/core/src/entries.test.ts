// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

// The entries that name no framework, server or config are for clients of any
// framework, so they must load in an app that has no React.
vi.mock("react", () => {
  throw new Error("the entry imported react");
});
vi.mock("convex/react", () => {
  throw new Error("the entry imported convex/react");
});

const { exports } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, string | { default?: string }> };

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const entries = Object.entries(exports).flatMap(([key, target]) => {
  const file = typeof target === "string" ? target : target.default;
  if (!file?.startsWith("./dist/")) return [];
  if (/react|server|nextjs|convex\.config|_generated/.test(key)) return [];
  return [[key, file.replace(/^\.\/dist\//, "./").replace(/\.js$/, ".ts")]];
});

test.each(entries)("%s loads without React", async (_key, file) => {
  expect(modules[file]).toBeDefined();
  await modules[file]!();
});
