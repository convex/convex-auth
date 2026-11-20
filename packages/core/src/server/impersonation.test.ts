/**
 * Tests `setupImpersonation` and `getImpersonation`.
 *
 * Runs as an app with the core component installed and a `users` table (the
 * same harness shape as `setup.test.ts`): a test method signs users up, and
 * the app's `authorize` rule lets admins impersonate everybody but admins.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { type GenericId, v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.ts";
import type {
  AuthorizeImpersonationFn,
  CreateUserFn,
  Impersonation,
  ImpersonateUserResult,
  StopImpersonatingResult,
  TokenBundle,
} from "../lib/types.ts";
import { registerCore, sessionIdentity } from "../testing/core.ts";
import { setupImpersonation } from "./impersonation.ts";
import { setupConvexAuth } from "./setup.ts";
import { getAuthUserId, getImpersonation, getOwnAuthUserId } from "./userId.ts";

const components = componentsGeneric() as unknown as {
  auth: ComponentApi<"auth">;
};

const schema = defineSchema({
  users: defineTable({ role: v.string() }),
  impersonationLog: defineTable({
    impersonatorUserId: v.id("users"),
    targetUserId: v.id("users"),
  }),
});

type UserId = GenericId<"users">;

const createUser = internalMutationGeneric({
  args: { method: v.object({ name: v.string(), profile: v.any() }) },
  returns: v.id("users"),
  handler: async (ctx, { method }) =>
    await ctx.db.insert("users", { role: method.profile.role }),
});

/** What the tests make the app's rule do in place of its normal check. */
let authorizeOverride: "throw" | "non-boolean" | null = null;

/**
 * The app's rule: admins impersonate everybody but admins. It writes an audit
 * record before it answers, as the docs recommend.
 */
const authorize = internalMutationGeneric({
  args: { impersonatorUserId: v.id("users"), targetUserId: v.id("users") },
  returns: v.any(),
  handler: async (ctx, { impersonatorUserId, targetUserId }) => {
    await ctx.db.insert("impersonationLog", {
      impersonatorUserId,
      targetUserId,
    });
    if (authorizeOverride === "throw") {
      throw new Error("the rule failed");
    }
    if (authorizeOverride === "non-boolean") {
      return "yes";
    }
    const impersonator = await ctx.db.get(impersonatorUserId);
    const target = await ctx.db.get(targetUserId);
    if (impersonator === null || target === null) {
      return false;
    }
    return impersonator.role === "admin" && target.role !== "admin";
  },
});

const authorizeRef = makeFunctionReference<"mutation">(
  "testApp:authorize",
) as unknown as AuthorizeImpersonationFn<"users">;

const ACCESS_TOKEN_TTL_SECONDS = 120;
const SESSION_MAX_LIFETIME_SECONDS = 4 * 60 * 60;
const core = setupConvexAuth({
  component: components.auth,
  accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  sessionMaxLifetimeSeconds: SESSION_MAX_LIFETIME_SECONDS,
});

const { authMutation } = core.bindMethod({
  name: "testMethod",
  createUser: makeFunctionReference<"mutation">(
    "testApp:createUser",
  ) as unknown as CreateUserFn<"testMethod", unknown, "users">,
});

const authenticatedBy = (componentsGeneric() as unknown as { authTest: object })
  .authTest;

const signUp = authMutation({
  args: { role: v.string() },
  returns: v.any(),
  handler: async (ctx, { role }) =>
    await ctx.convexAuth.completeSignUp({
      profile: { role },
      authenticatedBy,
    }),
});

const MAX_DURATION_SECONDS = 30 * 60;
const { impersonateUser, stopImpersonating, impersonation } =
  setupImpersonation(core, {
    maxDurationSeconds: MAX_DURATION_SECONDS,
  }).attachAuthorization({ authorize: authorizeRef });

/** What the server helpers report about the caller. */
const whoAmI = queryGeneric({
  args: {},
  returns: v.any(),
  handler: async (ctx) => ({
    userId: await getAuthUserId(ctx),
    impersonation: await getImpersonation(ctx),
  }),
});

/** A stand-in for a function that changes the caller's credentials. */
const changeCredentials = mutationGeneric({
  args: {},
  returns: v.any(),
  handler: async (ctx) => await getOwnAuthUserId(ctx),
});

const testApp = {
  createUser,
  authorize,
  signUp,
  impersonateUser,
  stopImpersonating,
  impersonation,
  whoAmI,
  changeCredentials,
  refreshSession: core.refreshSession,
};

const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  return t;
}

type ConvexTestApi = ReturnType<typeof setup>;

const signUpRef = makeFunctionReference<
  "mutation",
  { role: string },
  TokenBundle
>("testApp:signUp");
const impersonateUserRef = makeFunctionReference<
  "mutation",
  { userId: string },
  ImpersonateUserResult
>("testApp:impersonateUser");
const stopImpersonatingRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  StopImpersonatingResult
>("testApp:stopImpersonating");
const impersonationRef = makeFunctionReference<
  "query",
  Record<string, never>,
  Impersonation<"users"> | null
>("testApp:impersonation");
const whoAmIRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { userId: UserId | null; impersonation: Impersonation<"users"> | null }
>("testApp:whoAmI");
const changeCredentialsRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  UserId | null
>("testApp:changeCredentials");

/** Call as the session of the given tokens. */
function as(t: ConvexTestApi, tokens: { accessToken: string }) {
  return t.withIdentity(sessionIdentity(tokens));
}

/** Assert that a result carries a session, and narrow to its tokens. */
function expectComplete(
  result: ImpersonateUserResult | StopImpersonatingResult,
): TokenBundle {
  expect(result).toMatchObject({ status: "complete" });
  return (result as Extract<typeof result, { status: "complete" }>).tokens;
}

async function auditLog(t: ConvexTestApi) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("impersonationLog").collect()).map(
      ({ impersonatorUserId, targetUserId }) => ({
        impersonatorUserId,
        targetUserId,
      }),
    ),
  );
}

async function sessionCount(t: ConvexTestApi, userId: string) {
  return (
    await t.run(
      async (ctx) =>
        await ctx.runQuery(components.auth.public.listSessions, { userId }),
    )
  ).length;
}

beforeEach(() => {
  authorizeOverride = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("impersonateUser", () => {
  test("gives an authorized caller a session of the target", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });

    const tokens = expectComplete(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: alice.userId,
      }),
    );

    expect(tokens.userId).toBe(alice.userId);
    expect(await as(t, tokens).query(whoAmIRef, {})).toEqual({
      userId: alice.userId,
      impersonation: {
        impersonatorUserId: admin.userId,
        expiresAt: expect.any(Number),
      },
    });
    expect(await as(t, tokens).query(impersonationRef, {})).toEqual({
      impersonatorUserId: admin.userId,
      expiresAt: expect.any(Number),
    });
  });

  test("passes both user ids to the app's rule, whose record commits", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });

    await as(t, admin).mutation(impersonateUserRef, { userId: alice.userId });

    expect(await auditLog(t)).toEqual([
      { impersonatorUserId: admin.userId, targetUserId: alice.userId },
    ]);
  });

  test("refuses when the app's rule says no, and mints nothing", async () => {
    const t = setup();
    const alice = await t.mutation(signUpRef, { role: "member" });
    const bob = await t.mutation(signUpRef, { role: "member" });

    const result = await as(t, alice).mutation(impersonateUserRef, {
      userId: bob.userId,
    });

    expect(result).toEqual({
      status: "error",
      userError: { error: "NOT_AUTHORIZED" },
    });
    expect(await sessionCount(t, bob.userId)).toBe(1);
  });

  test("refuses when the app's rule returns something other than true", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    authorizeOverride = "non-boolean";

    const result = await as(t, admin).mutation(impersonateUserRef, {
      userId: alice.userId,
    });

    expect(result).toEqual({
      status: "error",
      userError: { error: "NOT_AUTHORIZED" },
    });
  });

  test("a rule that throws rolls back what it wrote", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    authorizeOverride = "throw";

    await expect(
      as(t, admin).mutation(impersonateUserRef, { userId: alice.userId }),
    ).rejects.toThrow("the rule failed");

    expect(await auditLog(t)).toEqual([]);
    expect(await sessionCount(t, alice.userId)).toBe(1);
  });

  test("a failure after the rule allowed rolls back the rule's record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    // The admin's session is past its max lifetime, but its row is still
    // there, as it is until something deletes it.
    vi.advanceTimersByTime(SESSION_MAX_LIFETIME_SECONDS * 1000 + 1);

    await expect(
      as(t, admin).mutation(impersonateUserRef, { userId: alice.userId }),
    ).rejects.toThrow("expired");

    expect(await auditLog(t)).toEqual([]);
  });

  test("refuses a caller who is not signed in", async () => {
    const t = setup();
    const alice = await t.mutation(signUpRef, { role: "member" });

    expect(
      await t.mutation(impersonateUserRef, { userId: alice.userId }),
    ).toEqual({ status: "error", userError: { error: "NOT_LOGGED_IN" } });
    expect(await auditLog(t)).toEqual([]);
  });

  test("refuses to impersonate oneself", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });

    expect(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: admin.userId,
      }),
    ).toEqual({
      status: "error",
      userError: { error: "CANNOT_IMPERSONATE_SELF" },
    });
    expect(await auditLog(t)).toEqual([]);
  });

  test("refuses to start an impersonation from an impersonation", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    const bob = await t.mutation(signUpRef, { role: "member" });
    const tokens = expectComplete(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: alice.userId,
      }),
    );

    expect(
      await as(t, tokens).mutation(impersonateUserRef, { userId: bob.userId }),
    ).toEqual({
      status: "error",
      userError: { error: "ALREADY_IMPERSONATING" },
    });
  });

  test("refuses an id that is not a user id", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });

    await expect(
      as(t, admin).mutation(impersonateUserRef, { userId: "nobody" }),
    ).rejects.toThrow();
  });

  test("uses the lifetimes of setupConvexAuth and its own max duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });

    const tokens = expectComplete(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: alice.userId,
      }),
    );

    const report = await as(t, tokens).query(impersonationRef, {});
    // convex-test moves its clock by a few milliseconds per document.
    expect(report!.expiresAt - Date.now()).toBeGreaterThanOrEqual(
      MAX_DURATION_SECONDS * 1000,
    );
    expect(report!.expiresAt - Date.now()).toBeLessThan(
      MAX_DURATION_SECONDS * 1000 + 100,
    );
    expect(tokens.refreshTokenExpiresAt).toBe(report!.expiresAt);
  });
});

describe("stopImpersonating", () => {
  test("gives the impersonator a session of their own again", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    const tokens = expectComplete(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: alice.userId,
      }),
    );

    const restored = expectComplete(
      await as(t, tokens).mutation(stopImpersonatingRef, {}),
    );

    expect(restored.userId).toBe(admin.userId);
    expect(await as(t, restored).query(whoAmIRef, {})).toEqual({
      userId: admin.userId,
      impersonation: null,
    });
  });

  test("reports a session that is not an impersonation", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });

    expect(await as(t, admin).mutation(stopImpersonatingRef, {})).toEqual({
      status: "error",
      userError: { error: "NOT_IMPERSONATING" },
    });
    expect(await t.mutation(stopImpersonatingRef, {})).toEqual({
      status: "error",
      userError: { error: "NOT_IMPERSONATING" },
    });
  });

  test("reports an impersonator whose own session expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    const tokens = expectComplete(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: alice.userId,
      }),
    );
    vi.advanceTimersByTime(SESSION_MAX_LIFETIME_SECONDS * 1000 + 1);

    expect(await as(t, tokens).mutation(stopImpersonatingRef, {})).toEqual({
      status: "error",
      userError: { error: "IMPERSONATOR_SESSION_ENDED" },
    });
    expect(await as(t, tokens).query(whoAmIRef, {})).toEqual({
      userId: null,
      impersonation: null,
    });
  });
});

describe("the helpers for app code", () => {
  test("getImpersonation is null for a normal session and for no session", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });

    expect(await as(t, admin).query(whoAmIRef, {})).toEqual({
      userId: admin.userId,
      impersonation: null,
    });
    expect(await t.query(whoAmIRef, {})).toEqual({
      userId: null,
      impersonation: null,
    });
    expect(await t.query(impersonationRef, {})).toBeNull();
  });

  test("getOwnAuthUserId refuses an impersonation session", async () => {
    const t = setup();
    const admin = await t.mutation(signUpRef, { role: "admin" });
    const alice = await t.mutation(signUpRef, { role: "member" });
    const tokens = expectComplete(
      await as(t, admin).mutation(impersonateUserRef, {
        userId: alice.userId,
      }),
    );

    await expect(
      as(t, tokens).mutation(changeCredentialsRef, {}),
    ).rejects.toThrow("IMPERSONATING");
    expect(await as(t, alice).mutation(changeCredentialsRef, {})).toBe(
      alice.userId,
    );
    expect(await t.mutation(changeCredentialsRef, {})).toBeNull();
  });
});

describe("the max duration of setupImpersonation", () => {
  const withMaxDuration = (maxDurationSeconds: number) => () =>
    setupImpersonation(core, { maxDurationSeconds });

  test("must be a finite number", () => {
    expect(withMaxDuration(Number.NaN)).toThrow("finite number");
    expect(withMaxDuration(Number.POSITIVE_INFINITY)).toThrow("finite number");
  });

  test("must be at least 60 seconds longer than the access-token TTL", () => {
    expect(withMaxDuration(ACCESS_TOKEN_TTL_SECONDS + 59)).toThrow(
      "60 seconds longer",
    );
    expect(withMaxDuration(ACCESS_TOKEN_TTL_SECONDS + 60)).not.toThrow();
  });

  test("must be at most the session max lifetime", () => {
    expect(withMaxDuration(SESSION_MAX_LIFETIME_SECONDS + 1)).toThrow(
      "session max lifetime",
    );
    expect(withMaxDuration(SESSION_MAX_LIFETIME_SECONDS)).not.toThrow();
  });

  test("defaults to one hour", async () => {
    // The default core's session max lifetime is 30 days.
    const defaultCore = setupConvexAuth({ component: components.auth });
    expect(() =>
      setupImpersonation(defaultCore).attachAuthorization({
        authorize: authorizeRef,
      }),
    ).not.toThrow();
  });
});
