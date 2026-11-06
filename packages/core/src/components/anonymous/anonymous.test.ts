import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  return t;
}

describe("anonymous auth", () => {
  test("createAnonymousAccount records the identity against its user", async () => {
    const t = setup();
    await t.mutation(api.provider.createAnonymousAccount, {
      anonymousId: "anon-1",
      userId: "user-1",
    });
    const accounts = await t.run(
      async (ctx) => await ctx.db.query("accounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      anonymousId: "anon-1",
      userId: "user-1",
    });
  });
});
