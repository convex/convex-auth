// @vitest-environment node
// The generic layer runs the TypeScript compiler, which needs Node.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import type { StructureModel } from "../../model.ts";
import { buildConvexModel } from "./index.ts";

const root = join(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
);

describe("the generic layer on one app, with no project layer", () => {
  let model: StructureModel;
  beforeAll(() => {
    model = buildConvexModel({
      root,
      apps: [join(root, "examples", "react-username-password", "convex")],
      frontends: true,
      types: ["node", "vite/client"],
    });
  }, 120_000);

  const ids = (kind: string) =>
    model.parts
      .filter((p) => p.kind === kind)
      .map((p) => p.id)
      .sort();
  const has = (kind: string, from: string, to: string) =>
    model.dependencies.some(
      (d) => d.kind === kind && d.from === from && d.to === to,
    );

  test("finds the app and the components it mounts, through their packages", () => {
    expect(model.project).toBe("convex");
    expect(ids("app")).toEqual(["app:react-username-password"]);
    expect(
      model.parts
        .filter((p) => p.kind === "component")
        .map((p) => [p.id, (p as { package: string | null }).package]),
    ).toEqual([
      ["component:auth", "@convex-dev/auth"],
      ["component:authPassword", "@convex-dev/auth"],
      ["component:authPassword/rateLimiter", "@convex-dev/rate-limiter"],
      ["component:authUsername", "@convex-dev/auth"],
    ]);
  });

  test("reads the tables of the app and of every component", () => {
    expect(ids("table")).toContain("table:app:react-username-password.users");
    expect(ids("table")).toContain("table:auth.refreshTokens");
    expect(ids("table")).toContain("table:authPassword/rateLimiter.rateLimits");
  });

  test("follows the app's own functions and the components' functions", () => {
    expect(
      has(
        "calls",
        "fn:app:react-username-password:currentUser.loggedInUser",
        "fn:authUsername:public.getUsername",
      ),
    ).toBe(true);
    expect(
      has("writes", "fn:auth:public.refresh", "table:auth.refreshTokens"),
    ).toBe(true);
    expect(
      has(
        "clientCalls",
        "app:react-username-password",
        "fn:app:react-username-password:currentUser.loggedInUser",
      ),
    ).toBe(true);
  });

  test("uses only the generic kinds, each labeled", () => {
    for (const [kind, info] of [
      ...Object.entries(model.kinds.parts),
      ...Object.entries(model.kinds.dependencies),
    ]) {
      expect(info.layer, kind).toBe("convex");
      expect(info.label.length, kind).toBeGreaterThan(0);
    }
  });
});
