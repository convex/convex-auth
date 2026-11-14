import { expect, test, vi } from "vitest";

// `@convex-dev/auth/methods/oauth` and `@convex-dev/auth/methods/username-passkey`
// are for client libraries of other frameworks, so they must load in an app
// that has no React.
vi.mock("react", () => {
  throw new Error("the entry imported react");
});
vi.mock("convex/react", () => {
  throw new Error("the entry imported convex/react");
});

test("the OAuth client loads without React", async () => {
  const { oauth } = await import("./oauth/client.ts");
  expect(oauth).toBeTypeOf("function");
});

test("the username + passkey client loads without React", async () => {
  const { runSignInOrSignUpFlow } = await import("./username-passkey/index.ts");
  expect(runSignInOrSignUpFlow).toBeTypeOf("function");
});
