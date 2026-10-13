/**
 * Tests the helpers `setupConvexAuth`'s `bindProvider` injects on
 * `ctx.convexAuth` for the handlers of a method.
 *
 * Runs as an app with the core component installed (the same harness shape as
 * `methods/oauth/componentBoundary.test.ts`): the real `setupConvexAuth` binds a
 * test method, whose `authMutation` exposes the helper under test as an
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

// For testing only: never expose a function like this publicly. It lets any
// caller sign out any user, since `revokeAllSessions` does no authorization.
// A real flow proves ownership of the account first (see
// `completePasswordRecovery`).
const revokeAllSessions = authMutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: async (ctx, { userId }) =>
    await ctx.convexAuth.revokeAllSessions(userId),
});

const testApp = {
  createUser,
  signUp,
  signIn,
  revokeOtherSessions,
  revokeAllSessions,
  // The core's own registered functions, exercised as an app would export them.
  isAuthenticated: core.isAuthenticated,
  signOut: core.signOut,
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

const revokeAllSessionsRef = makeFunctionReference<
  "mutation",
  { userId: string },
  number
>("testApp:revokeAllSessions");

/** The ids of the user's sessions, as the core lists them. */
async function sessionIdsOf(t: ReturnType<typeof setup>, userId: string) {
  const sessions = await t.run(
    async (ctx) =>
      await ctx.runQuery(components.auth.public.listSessions, { userId }),
  );
  return sessions.map((s) => s.sessionId);
}

const isAuthenticatedRef = makeFunctionReference<
  "query",
  Record<string, never>,
  boolean
>("testApp:isAuthenticated");

const signOutRef = makeFunctionReference<
  "mutation",
  { refreshToken: string },
  null
>("testApp:signOut");

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

describe("ctx.convexAuth.revokeAllSessions", () => {
  test("revokes every session of the user, the caller's included", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signInRef, { accountId: "alice" });

    const revoked = await t
      .withIdentity(sessionIdentity(bundle))
      .mutation(revokeAllSessionsRef, { userId: bundle.userId });
    expect(revoked).toBe(2);
    expect(await sessionIdsOf(t, bundle.userId)).toEqual([]);
  });

  test("needs no signed-in caller", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });

    expect(
      await t.mutation(revokeAllSessionsRef, { userId: bundle.userId }),
    ).toBe(1);
    expect(await sessionIdsOf(t, bundle.userId)).toEqual([]);
  });

  test("leaves the sessions of other users alone", async () => {
    const t = setup();
    const alice = await t.mutation(signUpRef, { accountId: "alice" });
    const bob = await t.mutation(signUpRef, { accountId: "bob" });

    expect(
      await t.mutation(revokeAllSessionsRef, { userId: alice.userId }),
    ).toBe(1);
    expect(await sessionIdsOf(t, bob.userId)).toEqual([
      sessionIdentity(bob).subject,
    ]);
  });

  test("deletes expired sessions without counting them", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const t = setup();
      const bundle = await t.mutation(signUpRef, { accountId: "alice" });
      // Past the default 30-day refresh-token TTL.
      vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
      await t.mutation(signInRef, { accountId: "alice" });

      expect(
        await t.mutation(revokeAllSessionsRef, { userId: bundle.userId }),
      ).toBe(1);
      expect(await sessionIdsOf(t, bundle.userId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns 0 for a user with no sessions", async () => {
    const t = setup();
    expect(await t.mutation(revokeAllSessionsRef, { userId: "nobody" })).toBe(
      0,
    );
  });
});

describe("isAuthenticated", () => {
  test("is false for a caller with no identity", async () => {
    const t = setup();
    expect(await t.query(isAuthenticatedRef, {})).toBe(false);
  });

  test("is false for a subject that is no session", async () => {
    const t = setup();
    expect(
      await t
        .withIdentity({ subject: "not-a-session-id" })
        .query(isAuthenticatedRef, {}),
    ).toBe(false);
  });

  test("is true while the session is live, and false once it is revoked", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const caller = t.withIdentity(sessionIdentity(bundle));
    expect(await caller.query(isAuthenticatedRef, {})).toBe(true);

    await t.mutation(signOutRef, { refreshToken: bundle.refreshToken });

    // The JWT is untouched and still verifies; the session is what died.
    expect(await caller.query(isAuthenticatedRef, {})).toBe(false);
  });
});
