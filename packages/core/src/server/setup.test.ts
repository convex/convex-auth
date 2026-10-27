/**
 * Tests the helpers `setupConvexAuth`'s `bindProvider` injects on
 * `ctx.convexAuth` for provider handlers.
 *
 * Runs as an app with the core component installed (the same harness shape as
 * `methods/oauth/componentBoundary.test.ts`): the real `setupConvexAuth` binds a
 * test provider, whose `authMutation` exposes the helper under test as an
 * app function the suite can call with a chosen identity.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  internalMutationGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { CreateUserFn, TokenBundle } from "../lib/types.ts";
import { registerCore, sessionIdentity } from "../testing/core.ts";
import { setupConvexAuth } from "./setup.ts";

const components = componentsGeneric() as unknown as {
  auth: ComponentApi<"auth">;
};

/**
 * Stand-in for the app's user-creating callback. Like a minimal real app it
 * owns no users table, and just echoes the provider-scoped account id back as
 * the app user id (the same contract as the component suite's fixture).
 */
const createUser = internalMutationGeneric({
  args: {
    provider: v.object({
      name: v.string(),
      accountId: v.string(),
      profile: v.any(),
    }),
  },
  returns: v.string(),
  handler: async (_ctx, args) => args.provider.accountId,
});

const core = setupConvexAuth({ component: components.auth });

const { authMutation } = core.bindProvider({
  name: "test-provider",
  // The runtime value `bindProvider` needs is a reference it can turn into a
  // function handle; the cast supplies the type-level contract the app's
  // codegen would.
  createUser: makeFunctionReference<"mutation">(
    "testApp:createUser",
  ) as unknown as CreateUserFn<"test-provider", unknown, "users">,
});

const signUp = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.convexAuth.completeSignUp({
      providerAccountId: accountId,
      profile: {},
    }),
});

const signIn = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.convexAuth.completeSignIn({
      providerAccountId: accountId,
      profile: {},
    }),
});

const revokeOtherSessions = authMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.convexAuth.revokeOtherSessions(),
});

const testApp = {
  createUser,
  signUp,
  signIn,
  revokeOtherSessions,
};

/**
 * The app's modules. convex-test takes the root directory from the first path
 * that contains `_generated`, so the `_generated/api.ts` entry only has to
 * exist.
 */
const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

function setup() {
  const t = convexTest(undefined, modules);
  registerCore(t);
  return t;
}

const signUpRef = makeFunctionReference<
  "mutation",
  { accountId: string },
  TokenBundle
>("testApp:signUp");

const signInRef = makeFunctionReference<
  "mutation",
  { accountId: string },
  TokenBundle
>("testApp:signIn");

const revokeOtherSessionsRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  number
>("testApp:revokeOtherSessions");

describe("ctx.convexAuth.revokeOtherSessions", () => {
  test("revokes every session of the user but the caller's", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signInRef, { accountId: "alice" });
    await t.mutation(signInRef, { accountId: "alice" });

    const revoked = await t
      .withIdentity(sessionIdentity(bundle))
      .mutation(revokeOtherSessionsRef, {});
    expect(revoked).toBe(2);
  });

  test("leaves the sessions of other users alone", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signInRef, { accountId: "alice" });
    const bobBundle = await t.mutation(signUpRef, { accountId: "bob" });
    await t.mutation(signInRef, { accountId: "bob" });

    const revoked = await t
      .withIdentity(sessionIdentity(bundle))
      .mutation(revokeOtherSessionsRef, {});
    expect(revoked).toBe(1);
    // Bob's other session survived, so Bob still has one to revoke.
    const bobRevoked = await t
      .withIdentity(sessionIdentity(bobBundle))
      .mutation(revokeOtherSessionsRef, {});
    expect(bobRevoked).toBe(1);
  });

  test("deletes expired sessions without counting them", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const t = setup();
      await t.mutation(signUpRef, { accountId: "alice" });
      // Past the default 30-day refresh-token TTL.
      vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
      await t.mutation(signInRef, { accountId: "alice" });
      const bundle = await t.mutation(signInRef, { accountId: "alice" });

      const asCaller = t.withIdentity(sessionIdentity(bundle));
      expect(await asCaller.mutation(revokeOtherSessionsRef, {})).toBe(1);
      // The expired session was deleted too, so nothing is left to revoke.
      const remaining = await asCaller.run(
        async (ctx) =>
          await ctx.runQuery(components.auth.public.listSessions, {
            userId: bundle.userId,
          }),
      );
      expect(remaining.map((s) => s.sessionId)).toEqual([
        sessionIdentity(bundle).subject,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns 0 when the caller is not signed in", async () => {
    const t = setup();
    await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signInRef, { accountId: "alice" });
    expect(await t.mutation(revokeOtherSessionsRef, {})).toBe(0);
  });

  test("returns 0 for a subject that is no session", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signInRef, { accountId: "alice" });
    const revoked = await t
      .withIdentity({ subject: bundle.userId })
      .mutation(revokeOtherSessionsRef, {});
    expect(revoked).toBe(0);
  });
});
