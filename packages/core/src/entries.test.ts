// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";

// Only the React and Next.js entries may load React. The others are for a
// backend or for a client of any framework, so they must load without it.
for (const name of [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "convex/react",
]) {
  vi.doMock(name, () => {
    throw new Error(`the entry imported ${name}`);
  });
}

const { exports } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, string | { default?: string }> };

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const entries = Object.entries(exports).flatMap(([key, target]) => {
  const file = typeof target === "string" ? target : target.default;
  if (!file?.startsWith("./dist/")) return [];
  if (/react|nextjs|convex\.config|_generated/.test(key)) return [];
  return [[key, file.replace(/^\.\/dist\//, "./").replace(/\.js$/, ".ts")]];
});

test.each(entries)("%s loads without React", async (_key, file) => {
  expect(modules[file]).toBeDefined();
  await modules[file]!();
});

test("the OAuth and passkey entries export their clients", async () => {
  const { oauth } = await import("./methods/oauth/client.ts");
  const { runSignInOrSignUpFlow } =
    await import("./methods/username-passkey/client.ts");
  expect(oauth).toBeTypeOf("function");
  expect(runSignInOrSignUpFlow).toBeTypeOf("function");
});
