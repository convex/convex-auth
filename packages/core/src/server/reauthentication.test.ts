/**
 * Tests the record of when the user of a session last proved who they are:
 * the `recordReauthentication` helper that `bindMethod` injects, and the
 * `getAuthenticationTime` and `requireRecentAuthentication` helpers of the
 * app.
 *
 * Same harness as `setup.test.ts`: the real `setupConvexAuth` binds a test
 * method, and the suite calls its functions with a chosen identity.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  internalMutationGeneric,
  type AnyDataModel,
  type GenericMutationCtx,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { CreateUserFn, TokenBundle } from "../lib/types.ts";
import { isReauthenticationRequiredError } from "../lib/reauthentication.ts";
import { registerCore, sessionIdentity } from "../testing/core.ts";
import {
  getAuthenticationTime,
  requireRecentAuthentication,
  type AuthenticationTime,
} from "./reauthentication.ts";
import { setupConvexAuth } from "./setup.ts";

const components = componentsGeneric() as unknown as {
  auth: ComponentApi<"auth">;
  authTest: object;
  authOther: object;
};

const createUser = internalMutationGeneric({
  args: { method: v.object({ name: v.string(), profile: v.any() }) },
  returns: v.string(),
  handler: async (_ctx, args) => args.method.profile.id,
});

const core = setupConvexAuth({ component: components.auth });

const { authMutation } = core.bindMethod({
  name: "testMethod",
  createUser: makeFunctionReference<"mutation">(
    "testApp:createUser",
  ) as unknown as CreateUserFn<"testMethod", unknown, "users">,
});

// A method that only signs existing users in.
const { authMutation: signInOnlyMutation } = core.bindSignInMethod({
  name: "signInOnly",
});

const signUp = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.convexAuth.completeSignUp({
      profile: { id: accountId },
      authenticatedBy: components.authTest,
    }),
});

const signIn = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.convexAuth.completeSignIn({
      userId: accountId,
      profile: {},
      authenticatedBy: components.authTest,
    }),
});

// The helpers that a sign-in-only method gets. Creating a user is a type
// error there.
const signInOnlyHelpers = signInOnlyMutation({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    // @ts-expect-error A sign-in-only method cannot create users.
    void ctx.convexAuth.completeSignUp;
    // @ts-expect-error A sign-in-only method cannot create users.
    void ctx.convexAuth.signUpWithoutSession;
    return Object.keys(ctx.convexAuth).sort();
  },
});

// For testing only: a real method calls the helper right after it verifies
// the user, never with a user id from the client.
const reauthenticate = authMutation({
  args: { userId: v.string(), other: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, { userId, other }) =>
    await ctx.convexAuth.recordReauthentication({
      userId,
      authenticatedBy: other ? components.authOther : components.authTest,
    }),
});

const authenticationTime = queryGeneric({
  args: { onlyOther: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, { onlyOther }) =>
    await getAuthenticationTime(
      ctx,
      onlyOther ? { authenticatedBy: [components.authOther] } : {},
    ),
});

const requireRecent = mutationGeneric({
  args: { maxAgeSeconds: v.number(), onlyOther: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, { maxAgeSeconds, onlyOther }) =>
    await requireRecentAuthentication(ctx, {
      maxAgeSeconds,
      ...(onlyOther ? { authenticatedBy: [components.authOther] } : {}),
    }),
});

const testApp = {
  createUser,
  signUp,
  signIn,
  signInOnlyHelpers,
  reauthenticate,
  authenticationTime,
  requireRecent,
  signOut: core.signOut,
  refreshSession: core.refreshSession,
};

const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

function setup() {
  const t = convexTest(undefined, modules);
  registerCore(t);
  return t;
}

/**
 * The components of the core's `reauthentications` rows. `convex-test`
 * exposes `runInComponent` at runtime but does not declare it, hence the
 * cast.
 */
async function reauthenticationComponents(t: ReturnType<typeof setup>) {
  const testApi = t as unknown as {
    runInComponent<Output>(
      componentPath: string,
      handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
    ): Promise<Output>;
  };
  return await testApi.runInComponent("auth", async (ctx) => {
    const rows = await ctx.db.query("reauthentications").collect();
    return rows.map((row) => row.component as string).sort();
  });
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
const signInOnlyHelpersRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string[]
>("testApp:signInOnlyHelpers");
const reauthenticateRef = makeFunctionReference<
  "mutation",
  { userId: string; other?: boolean },
  { authenticatedAt: number }
>("testApp:reauthenticate");
const authenticationTimeRef = makeFunctionReference<
  "query",
  { onlyOther?: boolean },
  AuthenticationTime | null
>("testApp:authenticationTime");
const requireRecentRef = makeFunctionReference<
  "mutation",
  { maxAgeSeconds: number; onlyOther?: boolean },
  AuthenticationTime & { userId: string }
>("testApp:requireRecent");
const signOutRef = makeFunctionReference<
  "mutation",
  { refreshToken: string },
  null
>("testApp:signOut");
const refreshSessionRef = makeFunctionReference<
  "mutation",
  { refreshToken: string },
  unknown
>("testApp:refreshSession");

const START = new Date("2026-01-01T00:00:00Z").getTime();
const MINUTE = 60 * 1000;

// convex-test adds a fraction of a millisecond to `_creationTime` to keep it
// unique, so the times match to the millisecond.
const at = (time: number) => expect.closeTo(time, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

/** The `data` of the `ConvexError` that `promise` rejects with. */
async function convexErrorData(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the call to throw.");
    },
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<Record<string, Value>>).data;
}

describe("getAuthenticationTime", () => {
  test("is the sign-in right after a sign-in", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });

    const time = await t
      .withIdentity(sessionIdentity(bundle))
      .query(authenticationTimeRef, {});
    expect(time).toEqual({ authenticatedAt: at(START), component: "authTest" });
  });

  test("is null when the caller is not signed in", async () => {
    const t = setup();
    expect(await t.query(authenticationTimeRef, {})).toBeNull();
  });

  test("is the latest re-authentication after one", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const alice = t.withIdentity(sessionIdentity(bundle));

    vi.advanceTimersByTime(20 * MINUTE);
    const recorded = await alice.mutation(reauthenticateRef, {
      userId: "alice",
      other: true,
    });
    expect(recorded).toEqual({ authenticatedAt: at(START + 20 * MINUTE) });
    expect(await alice.query(authenticationTimeRef, {})).toEqual({
      authenticatedAt: at(START + 20 * MINUTE),
      component: "authOther",
    });
  });

  test("counts only the given components with `authenticatedBy`", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const alice = t.withIdentity(sessionIdentity(bundle));

    // The sign-in used `authTest`, so nothing matches `authOther` yet.
    expect(
      await alice.query(authenticationTimeRef, { onlyOther: true }),
    ).toBeNull();

    vi.advanceTimersByTime(MINUTE);
    await alice.mutation(reauthenticateRef, { userId: "alice", other: true });
    vi.advanceTimersByTime(MINUTE);
    await alice.mutation(reauthenticateRef, { userId: "alice" });

    expect(
      await alice.query(authenticationTimeRef, { onlyOther: true }),
    ).toEqual({ authenticatedAt: at(START + MINUTE), component: "authOther" });
    expect(await alice.query(authenticationTimeRef, {})).toEqual({
      authenticatedAt: at(START + 2 * MINUTE),
      component: "authTest",
    });
  });
});

describe("requireRecentAuthentication", () => {
  test("passes right after sign-in and fails once maxAge is past", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const alice = t.withIdentity(sessionIdentity(bundle));

    expect(
      await alice.mutation(requireRecentRef, { maxAgeSeconds: 300 }),
    ).toEqual({
      userId: "alice",
      authenticatedAt: at(START),
      component: "authTest",
    });

    vi.advanceTimersByTime(5 * MINUTE);
    // Exactly `maxAgeSeconds` old still passes.
    await alice.mutation(requireRecentRef, { maxAgeSeconds: 300 });

    vi.advanceTimersByTime(1);
    const promise = alice.mutation(requireRecentRef, { maxAgeSeconds: 300 });
    expect(await convexErrorData(promise)).toEqual({
      error: "REAUTHENTICATION_REQUIRED",
    });
  });

  test("passes again after a re-authentication", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const alice = t.withIdentity(sessionIdentity(bundle));

    vi.advanceTimersByTime(60 * MINUTE);
    await alice.mutation(reauthenticateRef, { userId: "alice" });
    expect(
      await alice.mutation(requireRecentRef, { maxAgeSeconds: 300 }),
    ).toMatchObject({ authenticatedAt: at(START + 60 * MINUTE) });
  });

  test("throws an error that isReauthenticationRequiredError recognizes", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    vi.advanceTimersByTime(10 * MINUTE);

    const error = await t
      .withIdentity(sessionIdentity(bundle))
      .mutation(requireRecentRef, { maxAgeSeconds: 60 })
      .catch((error: unknown) => error);
    expect(isReauthenticationRequiredError(error)).toBe(true);
    expect(isReauthenticationRequiredError(new Error("other"))).toBe(false);
    expect(
      isReauthenticationRequiredError(new ConvexError({ error: "OTHER" })),
    ).toBe(false);
  });

  test("requires a recent authentication with the given components", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const alice = t.withIdentity(sessionIdentity(bundle));

    // A fresh sign-in with `authTest` does not count for `authOther`.
    const promise = alice.mutation(requireRecentRef, {
      maxAgeSeconds: 300,
      onlyOther: true,
    });
    expect(await convexErrorData(promise)).toEqual({
      error: "REAUTHENTICATION_REQUIRED",
    });

    await alice.mutation(reauthenticateRef, { userId: "alice", other: true });
    await alice.mutation(requireRecentRef, {
      maxAgeSeconds: 300,
      onlyOther: true,
    });
  });

  test("throws NOT_LOGGED_IN when the caller is not signed in", async () => {
    const t = setup();
    const promise = t.mutation(requireRecentRef, { maxAgeSeconds: 300 });
    expect(await convexErrorData(promise)).toEqual({ error: "NOT_LOGGED_IN" });
  });

  test("throws NOT_LOGGED_IN after sign-out", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signOutRef, { refreshToken: bundle.refreshToken });

    const promise = t
      .withIdentity(sessionIdentity(bundle))
      .mutation(requireRecentRef, { maxAgeSeconds: 300 });
    expect(await convexErrorData(promise)).toEqual({ error: "NOT_LOGGED_IN" });
  });

  test("refuses a negative maxAgeSeconds", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await expect(
      t
        .withIdentity(sessionIdentity(bundle))
        .mutation(requireRecentRef, { maxAgeSeconds: -1 }),
    ).rejects.toThrow(/maxAgeSeconds/);
  });
});

describe("ctx.convexAuth.recordReauthentication", () => {
  test("does not affect another session of the same user", async () => {
    const t = setup();
    const first = await t.mutation(signUpRef, { accountId: "alice" });
    const second = await t.mutation(signInRef, { accountId: "alice" });

    vi.advanceTimersByTime(30 * MINUTE);
    await t
      .withIdentity(sessionIdentity(first))
      .mutation(reauthenticateRef, { userId: "alice" });

    await t
      .withIdentity(sessionIdentity(first))
      .mutation(requireRecentRef, { maxAgeSeconds: 300 });
    const promise = t
      .withIdentity(sessionIdentity(second))
      .mutation(requireRecentRef, { maxAgeSeconds: 300 });
    expect(await convexErrorData(promise)).toEqual({
      error: "REAUTHENTICATION_REQUIRED",
    });
  });

  test("refuses a user other than the session's", async () => {
    const t = setup();
    const alice = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signUpRef, { accountId: "bob" });

    await expect(
      t
        .withIdentity(sessionIdentity(alice))
        .mutation(reauthenticateRef, { userId: "bob" }),
    ).rejects.toThrow(/different user/);
  });

  test("refuses a signed-out caller", async () => {
    const t = setup();
    await expect(
      t.mutation(reauthenticateRef, { userId: "alice" }),
    ).rejects.toThrow(/not signed in/);
  });

  test("refuses a session that is gone", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t.mutation(signOutRef, { refreshToken: bundle.refreshToken });

    await expect(
      t
        .withIdentity(sessionIdentity(bundle))
        .mutation(reauthenticateRef, { userId: "alice" }),
    ).rejects.toThrow(/session does not exist/);
  });

  test("keeps one row per component and leaves the session row alone", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    const alice = t.withIdentity(sessionIdentity(bundle));
    const sessionId = sessionIdentity(bundle).subject;
    const sessionRow = async () =>
      await t.run(
        async (ctx) =>
          await ctx.runQuery(components.auth.public.getSession, { sessionId }),
      );
    const before = await sessionRow();

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(MINUTE);
      await alice.mutation(reauthenticateRef, { userId: "alice" });
      await alice.mutation(reauthenticateRef, {
        userId: "alice",
        other: true,
      });
    }
    // A refresh does not move the authentication time.
    vi.advanceTimersByTime(MINUTE);
    await t.mutation(refreshSessionRef, { refreshToken: bundle.refreshToken });

    expect(await reauthenticationComponents(t)).toEqual([
      "authOther",
      "authTest",
    ]);
    expect(await sessionRow()).toEqual(before);
    expect(await alice.query(authenticationTimeRef, {})).toEqual({
      authenticatedAt: at(START + 3 * MINUTE),
      component: "authOther",
    });
  });

  test("sign-out erases the session's re-authentications", async () => {
    const t = setup();
    const bundle = await t.mutation(signUpRef, { accountId: "alice" });
    await t
      .withIdentity(sessionIdentity(bundle))
      .mutation(reauthenticateRef, { userId: "alice" });
    await t.mutation(signOutRef, { refreshToken: bundle.refreshToken });

    expect(await reauthenticationComponents(t)).toEqual([]);
  });
});

describe("bindSignInMethod", () => {
  test("gives no helper that creates users", async () => {
    const t = setup();
    expect(await t.mutation(signInOnlyHelpersRef, {})).toEqual([
      "completeSignIn",
      "recordReauthentication",
      "revokeAllSessions",
      "revokeOtherSessions",
    ]);
  });
});
