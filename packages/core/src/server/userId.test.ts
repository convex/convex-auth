import { describe, expect, expectTypeOf, test } from "vitest";
import type { Auth, UserIdentity } from "convex/server";
import type { GenericId } from "convex/values";
import { getAuthUserId } from "./userId.ts";

/** A ctx whose `auth` reports the given identity, as Convex's would. */
function ctxWithIdentity(identity: UserIdentity | null) {
  return {
    auth: {
      getUserIdentity: async () => identity,
    } as unknown as Auth,
  };
}

describe("getAuthUserId", () => {
  test("returns the identity's subject, which the core mints as the user id", async () => {
    const ctx = ctxWithIdentity({
      tokenIdentifier: "https://example.convex.cloud/components/auth|user-1",
      subject: "user-1",
      issuer: "https://example.convex.cloud/components/auth",
    });
    expect(await getAuthUserId(ctx)).toBe("user-1");
  });

  test("returns null when the caller has no identity", async () => {
    expect(await getAuthUserId(ctxWithIdentity(null))).toBe(null);
  });

  test("types the id as one in the users table", () => {
    expectTypeOf(
      getAuthUserId(ctxWithIdentity(null)),
    ).resolves.toEqualTypeOf<GenericId<"users"> | null>();
  });

  test("types the id as one in the table the caller names", () => {
    expectTypeOf(
      getAuthUserId<"members">,
    ).returns.resolves.toEqualTypeOf<GenericId<"members"> | null>();
  });
});
