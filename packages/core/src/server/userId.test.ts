import { describe, expect, expectTypeOf, test } from "vitest";
import {
  componentsGeneric,
  getFunctionAddress,
  type Auth,
  type FunctionReference,
  type UserIdentity,
} from "convex/server";
import type { GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import { getAuthUserId } from "./userId.ts";

/**
 * A ctx whose `auth` reports the given identity, as Convex's would, and whose
 * `runQuery` answers the core's `getSession` from `sessions`.
 */
function ctxWithIdentity(
  identity: UserIdentity | null,
  sessions: Record<string, string> = {},
) {
  const calls: { address: unknown; args: unknown }[] = [];
  return {
    calls,
    auth: {
      getUserIdentity: async () => identity,
    } as unknown as Auth,
    runQuery: (async (
      query: FunctionReference<"query", "public" | "internal">,
      args: { sessionId: string },
    ) => {
      calls.push({ address: getFunctionAddress(query), args });
      const userId = sessions[args.sessionId];
      return userId === undefined ? null : { userId };
    }) as never,
  };
}

const identity = {
  tokenIdentifier: "https://example.convex.cloud/components/auth|session-1",
  subject: "session-1",
  issuer: "https://example.convex.cloud/components/auth",
};

describe("getAuthUserId", () => {
  test("returns the user of the session the identity's subject names", async () => {
    const ctx = ctxWithIdentity(identity, { "session-1": "user-1" });
    expect(await getAuthUserId(ctx)).toBe("user-1");
    expect(ctx.calls).toEqual([
      {
        address: {
          reference: "_reference/childComponent/auth/public/getSession",
        },
        args: { sessionId: "session-1" },
      },
    ]);
  });

  test("calls the component it is given", async () => {
    const component = (
      componentsGeneric() as unknown as { myAuth: ComponentApi }
    ).myAuth;
    const ctx = ctxWithIdentity(identity, { "session-1": "user-1" });
    expect(await getAuthUserId(ctx, component)).toBe("user-1");
    expect(ctx.calls).toEqual([
      {
        address: {
          reference: "_reference/childComponent/myAuth/public/getSession",
        },
        args: { sessionId: "session-1" },
      },
    ]);
  });

  test("returns null when the session is gone", async () => {
    expect(await getAuthUserId(ctxWithIdentity(identity))).toBe(null);
  });

  test("returns null when the caller has no identity", async () => {
    const ctx = ctxWithIdentity(null);
    expect(await getAuthUserId(ctx)).toBe(null);
    expect(ctx.calls).toEqual([]);
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
