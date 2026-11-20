/**
 * Tests the impersonation functions of the core component, and what
 * impersonation changes in `refresh`, `getSession`, `listSessions`, and the
 * deletion of sessions.
 *
 * Runs the component as the root app, like `core.test.ts`.
 *
 * @module
 */
import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import type { Doc, Id } from "./_generated/dataModel.ts";
import schema from "./schema.ts";
import * as testApp from "./testApp.fixture.ts";
import type { RefreshResult, TokenBundle } from "../lib/types.ts";
import { resolveTtlConfig } from "../lib/ttl.ts";
import {
  IMPERSONATION_STOP_GRACE_MS,
  MAX_SESSIONS_PER_USER,
  REFRESH_GRACE_MS,
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
} from "./sessions.ts";

const modules = {
  ...import.meta.glob(["./**/*.ts", "!./**/*.fixture.ts"]),
  "./testApp.ts": async () => testApp,
};

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL = resolveTtlConfig({});
/** The duration the tests give an impersonation unless they say otherwise. */
const ONE_HOUR_SECONDS = 60 * 60;

function setup() {
  return convexTest({ schema, modules });
}

type ConvexTestApi = ReturnType<typeof setup>;
type Lifetimes = ReturnType<typeof resolveTtlConfig>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  testApp.resetUserCallbackCalls();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Sign a user in, as a sign-in method does once it verified them. */
async function signIn(
  t: ConvexTestApi,
  userId: string,
  lifetimes: Lifetimes = DEFAULT_TTL,
) {
  return await t.mutation(api.public._internal_dangerous_signIn, {
    claims: { method: "usernamePassword", profile: {} },
    componentPath: "authPassword",
    userId,
    onSignInHandle: "testApp:onSignIn",
    ...lifetimes,
  });
}

function sessionIdOf(tokens: { accessToken: string }): Id<"sessions"> {
  return decodeJwt(tokens.accessToken).sub as Id<"sessions">;
}

/** Start an impersonation of `targetUserId` from the session of `tokens`. */
async function impersonate(
  t: ConvexTestApi,
  tokens: { accessToken: string },
  targetUserId: string,
  options: { maxDurationSeconds?: number; lifetimes?: Lifetimes } = {},
) {
  return await t.mutation(api.public._internal_dangerous_impersonate, {
    impersonatorSessionId: sessionIdOf(tokens),
    targetUserId,
    maxDurationSeconds: options.maxDurationSeconds ?? ONE_HOUR_SECONDS,
    ...(options.lifetimes ?? DEFAULT_TTL),
  });
}

/** Stop the impersonation whose session `tokens` belong to. */
async function stop(
  t: ConvexTestApi,
  tokens: { accessToken: string },
  lifetimes: Lifetimes = DEFAULT_TTL,
) {
  return await t.mutation(api.public._internal_dangerous_stopImpersonation, {
    sessionId: sessionIdOf(tokens),
    ...lifetimes,
  });
}

/** Assert a stop restored the impersonator, and narrow to their bundle. */
function expectRestored(result: Awaited<ReturnType<typeof stop>>): TokenBundle {
  expect(result.kind).toBe("restored");
  return (result as Extract<typeof result, { kind: "restored" }>).tokens;
}

async function refresh(
  t: ConvexTestApi,
  refreshToken: string,
  lifetimes: Lifetimes = DEFAULT_TTL,
) {
  return await t.mutation(api.public.refresh, { refreshToken, ...lifetimes });
}

function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

async function sessionOf(t: ConvexTestApi, tokens: { accessToken: string }) {
  return await t.run(async (ctx) => ctx.db.get(sessionIdOf(tokens)));
}

async function sessionCount(t: ConvexTestApi) {
  return await t.run(
    async (ctx) => (await ctx.db.query("sessions").collect()).length,
  );
}

/** The refresh tokens of a session in one state. */
async function tokensOf(
  t: ConvexTestApi,
  tokens: { accessToken: string },
  state: Doc<"refreshTokens">["state"],
) {
  const sessionId = sessionIdOf(tokens);
  return await t.run(async (ctx) =>
    ctx.db
      .query("refreshTokens")
      .withIndex("by_session_state", (q) =>
        q.eq("sessionId", sessionId).eq("state", state),
      )
      .collect(),
  );
}

/** Let the grace period of a stop pass, and run the deletion it scheduled. */
async function passStopGracePeriod(t: ConvexTestApi) {
  vi.advanceTimersByTime(IMPERSONATION_STOP_GRACE_MS);
  await t.finishAllScheduledFunctions(() => vi.runAllTimers());
}

/**
 * When the impersonation ends. convex-test keeps `_creationTime` unique by
 * moving its clock a millisecond per document, so the tests read the stored
 * value instead of computing it from the fake clock.
 */
async function expiresAtOf(t: ConvexTestApi, tokens: { accessToken: string }) {
  return (await sessionOf(t, tokens))!.impersonation!.expiresAt;
}

/**
 * Longer than `REFRESH_GRACE_MS` by more than the few milliseconds that
 * convex-test adds to `_creationTime`.
 */
const PAST_REFRESH_GRACE_MS = REFRESH_GRACE_MS + 100;

/** An admin signed in, and an impersonation of `"alice"` started by them. */
async function startImpersonation(t: ConvexTestApi) {
  const admin = await signIn(t, "admin");
  await signIn(t, "alice");
  const impersonation = await impersonate(t, admin, "alice");
  return { admin, impersonation };
}

describe("starting an impersonation", () => {
  test("mints a session of the target that records the impersonator", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");

    const impersonation = await impersonate(t, admin, "alice");

    expect(impersonation.userId).toBe("alice");
    expect(await sessionOf(t, impersonation)).toMatchObject({
      userId: "alice",
      component: "auth",
      impersonation: {
        impersonatorUserId: "admin",
        impersonatorSessionId: sessionIdOf(admin),
        expiresAt: Date.now() + HOUR_MS,
      },
    });
    expect(impersonation.refreshTokenExpiresAt).toBe(Date.now() + HOUR_MS);
  });

  test("does not run the app's onSignIn", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    testApp.resetUserCallbackCalls();

    await impersonate(t, admin, "alice");

    expect(testApp.getOnSignInCalls()).toEqual([]);
  });

  test("does not record the target as a created user", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");

    await impersonate(t, admin, "alice");

    const created = await t.run(async (ctx) =>
      (await ctx.db.query("createdUserIds").collect()).map((r) => r.userId),
    );
    expect(created).toEqual(["admin"]);
  });

  test("getSession resolves to the target and reports the impersonator", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    expect(
      await t.query(api.public.getSession, {
        sessionId: sessionIdOf(impersonation),
      }),
    ).toEqual({
      userId: "alice",
      impersonation: {
        impersonatorUserId: "admin",
        expiresAt: await expiresAtOf(t, impersonation),
      },
    });
    expect(
      await t.query(api.public.getSession, { sessionId: sessionIdOf(admin) }),
    ).toEqual({ userId: "admin" });
  });

  test("listSessions reports the impersonation among the target's sessions", async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);

    const listed = await t.query(api.public.listSessions, { userId: "alice" });

    expect(listed).toHaveLength(2);
    expect(
      listed.find((s) => s.sessionId === sessionIdOf(impersonation)),
    ).toMatchObject({
      impersonation: {
        impersonatorUserId: "admin",
        expiresAt: await expiresAtOf(t, impersonation),
      },
    });
    expect(
      listed.find((s) => s.sessionId !== sessionIdOf(impersonation)),
    ).not.toHaveProperty("impersonation");
  });

  test("refuses to start from an impersonation session", async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);

    await expect(impersonate(t, impersonation, "bob")).rejects.toThrow(
      "from an impersonation session",
    );
  });

  test("refuses a second impersonation while the first is live", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    await expect(impersonate(t, admin, "bob")).rejects.toThrow(
      "already has an impersonation",
    );
    // The first impersonation is untouched.
    expect(await sessionOf(t, impersonation)).not.toBeNull();
  });

  test("allows a new impersonation once the first is stopped", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    expectRestored(await stop(t, impersonation));

    // Still inside the grace period of the stop.
    const second = await impersonate(t, admin, "bob");

    expect(second.userId).toBe("bob");
  });

  test("refuses to impersonate oneself, or nobody", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");

    await expect(impersonate(t, admin, "admin")).rejects.toThrow("themself");
    await expect(impersonate(t, admin, "")).rejects.toThrow("no user id");
  });

  test("refuses a caller with no session", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    await t.mutation(api.public.signOut, { refreshToken: admin.refreshToken });

    await expect(impersonate(t, admin, "alice")).rejects.toThrow("no session");
  });

  test("refuses an expired impersonator session whose row is still there", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    vi.advanceTimersByTime(DEFAULT_TTL.sessionMaxLifetimeSeconds * 1000 + 1);

    await expect(impersonate(t, admin, "alice")).rejects.toThrow("expired");
  });

  test("caps the impersonation at the impersonator session's max lifetime", async () => {
    const t = setup();
    const lifetimes = resolveTtlConfig({
      sessionMaxLifetimeSeconds: 2 * ONE_HOUR_SECONDS,
    });
    const admin = await signIn(t, "admin", lifetimes);
    const adminSession = (await sessionOf(t, admin))!;
    // Half an hour before the impersonator session reaches its max lifetime.
    vi.advanceTimersByTime(1.5 * HOUR_MS);

    const impersonation = await impersonate(t, admin, "alice", { lifetimes });

    const deadline = adminSession._creationTime + 2 * HOUR_MS;
    expect((await sessionOf(t, impersonation))!.impersonation!.expiresAt).toBe(
      deadline,
    );
    expect(impersonation.refreshTokenExpiresAt).toBe(deadline);
  });

  test("refuses a duration that is not a positive number", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");

    for (const maxDurationSeconds of [0, -1, Number.NaN]) {
      await expect(
        impersonate(t, admin, "alice", { maxDurationSeconds }),
      ).rejects.toThrow("positive number");
    }
  });
});

describe("stopping an impersonation", () => {
  test("returns a session of the impersonator that refreshes normally", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    const restored = expectRestored(await stop(t, impersonation));

    expect(restored.userId).toBe("admin");
    expect(sessionIdOf(restored)).toBe(sessionIdOf(admin));
    const rotated = expectRotated(await refresh(t, restored.refreshToken));
    expectRotated(await refresh(t, rotated.refreshToken));
    expect(await sessionOf(t, admin)).not.toBeNull();
  });

  test("drops the token the impersonator held before, and a replay of it revokes the session", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    expectRestored(await stop(t, impersonation));

    expect(await tokensOf(t, admin, "issued")).toHaveLength(1);
    expect(await tokensOf(t, admin, "dropped")).toHaveLength(1);
    expect((await refresh(t, admin.refreshToken)).kind).toBe("noSession");
    expect(await sessionOf(t, admin)).toBeNull();
  });

  test("keeps the impersonation session for the grace period, then deletes it alone", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    expectRestored(await stop(t, impersonation));

    vi.advanceTimersByTime(IMPERSONATION_STOP_GRACE_MS - 1);
    await t.finishInProgressScheduledFunctions();
    expect(
      await t.query(api.public.getSession, {
        sessionId: sessionIdOf(impersonation),
      }),
    ).toMatchObject({ userId: "alice" });

    vi.advanceTimersByTime(1);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).not.toBeNull();
  });

  test("a stopped impersonation session still refreshes inside the grace period", async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);
    expectRestored(await stop(t, impersonation));

    // A refresh that was under way when the stop committed.
    const rotated = expectRotated(await refresh(t, impersonation.refreshToken));

    expect(rotated.userId).toBe("alice");
    expect(await sessionOf(t, impersonation)).not.toBeNull();
  });

  test("a stopped impersonation session refreshes inside the grace period even past its expiry", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    const impersonation = await impersonate(t, admin, "alice", {
      maxDurationSeconds: 120,
    });
    vi.advanceTimersByTime(119_000);
    expectRestored(await stop(t, impersonation));
    vi.advanceTimersByTime(2000);

    const rotated = expectRotated(await refresh(t, impersonation.refreshToken));

    // The cap at the impersonation's expiry no longer applies.
    expect(rotated.refreshTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(await sessionOf(t, impersonation)).not.toBeNull();
    expect(await sessionOf(t, admin)).not.toBeNull();
  });

  test("a repeated stop returns a second valid token, and the first refresh drops the other", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    const first = expectRestored(await stop(t, impersonation));
    const second = expectRestored(await stop(t, impersonation));

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await tokensOf(t, admin, "issued")).toHaveLength(2);
    // The client kept the second response.
    expectRotated(await refresh(t, second.refreshToken));
    expect((await refresh(t, first.refreshToken)).kind).toBe("noSession");
  });

  test("either response of a repeated stop works", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const first = expectRestored(await stop(t, impersonation));
    expectRestored(await stop(t, impersonation));

    // The client kept the first response.
    const rotated = expectRotated(await refresh(t, first.refreshToken));

    expectRotated(await refresh(t, rotated.refreshToken));
    expect(await sessionOf(t, admin)).not.toBeNull();
  });

  test("a repeated stop issues nothing once the restored session was refreshed", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const restored = expectRestored(await stop(t, impersonation));
    const rotated = expectRotated(await refresh(t, restored.refreshToken));

    // A tab that is still connected as the impersonation stops again.
    expect((await stop(t, impersonation)).kind).toBe("notImpersonating");

    expect(await tokensOf(t, admin, "issued")).toHaveLength(1);
    expectRotated(await refresh(t, rotated.refreshToken));
  });

  test("a stop can be repeated after the impersonator session refreshed twice right after the start", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    const impersonation = await impersonate(t, admin, "alice");
    // Two refreshes of the impersonator session land before it is suspended.
    // The second redeems a token that is newer than the impersonation.
    const once = expectRotated(await refresh(t, admin.refreshToken));
    expectRotated(await refresh(t, once.refreshToken));
    // The response of the first stop is lost.
    expectRestored(await stop(t, impersonation));

    const restored = expectRestored(await stop(t, impersonation));

    expectRotated(await refresh(t, restored.refreshToken));
  });

  test("a repeated stop issues nothing once the impersonator started another impersonation", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const restored = expectRestored(await stop(t, impersonation));
    const second = await impersonate(t, restored, "bob");

    // The access token of the stopped impersonation is replayed.
    expect((await stop(t, impersonation)).kind).toBe("notImpersonating");

    expect(await tokensOf(t, admin, "issued")).toHaveLength(1);
    expect(await sessionOf(t, second)).not.toBeNull();

    // Once the newer impersonation stops, only it can restore the session.
    expectRestored(await stop(t, second));
    expect((await stop(t, impersonation)).kind).toBe("notImpersonating");
    expectRestored(await stop(t, second));

    // Even once the newer impersonation is gone.
    await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(second)],
    });
    expect(await sessionOf(t, admin)).not.toBeNull();
    expect((await stop(t, impersonation)).kind).toBe("notImpersonating");
  });

  test("a repeated stop of a superseded impersonation leaves the newer one alone, even past the impersonator's max lifetime", async () => {
    const t = setup();
    const lifetimes = resolveTtlConfig({
      sessionMaxLifetimeSeconds: 2 * ONE_HOUR_SECONDS,
    });
    const admin = await signIn(t, "admin", lifetimes);
    const impersonation = await impersonate(t, admin, "alice", {
      maxDurationSeconds: 2 * ONE_HOUR_SECONDS,
      lifetimes,
    });
    // The first stop comes 5 seconds before the impersonator session reaches
    // its max lifetime.
    vi.advanceTimersByTime(2 * HOUR_MS - 5000);
    const restored = expectRestored(await stop(t, impersonation, lifetimes));
    // A second impersonation, inside the grace period of that stop.
    const second = await impersonate(t, restored, "bob", { lifetimes });
    // 6 seconds later the impersonator session is past its max lifetime, and
    // the grace period of the first stop is not over.
    vi.advanceTimersByTime(6000);
    expect(await sessionOf(t, impersonation)).not.toBeNull();

    // A superseded stop never judges whether the impersonator session
    // expired, so it leaves both sessions untouched.
    expect((await stop(t, impersonation, lifetimes)).kind).toBe(
      "notImpersonating",
    );

    expect(await sessionOf(t, admin)).not.toBeNull();
    expect(await sessionOf(t, second)).not.toBeNull();
  });

  test(`refuses a stop once the impersonator session has ${STANDARD_ISSUED_REFRESH_TOKEN_LIMIT} issued tokens`, async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);
    for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
      expectRestored(await stop(t, impersonation));
    }

    await expect(stop(t, impersonation)).rejects.toThrow("too many times");
  });

  test("repeated cycles without a refresh leave one issued token", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    let current: TokenBundle = admin;

    for (let i = 0; i < 5; i++) {
      const impersonation = await impersonate(t, current, "alice");
      current = expectRestored(await stop(t, impersonation));
      await passStopGracePeriod(t);
    }

    expect(await tokensOf(t, admin, "issued")).toHaveLength(1);
    expectRotated(await refresh(t, current.refreshToken));
  });

  test("reports a session that is not an impersonation, or is gone", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    expect((await stop(t, admin)).kind).toBe("notImpersonating");

    expectRestored(await stop(t, impersonation));
    await passStopGracePeriod(t);
    expect((await stop(t, impersonation)).kind).toBe("notImpersonating");
  });

  test("ends both sessions when the impersonator session is past its max lifetime", async () => {
    const t = setup();
    const lifetimes = resolveTtlConfig({
      sessionMaxLifetimeSeconds: 2 * ONE_HOUR_SECONDS,
    });
    const admin = await signIn(t, "admin", lifetimes);
    const impersonation = await impersonate(t, admin, "alice", {
      maxDurationSeconds: 2 * ONE_HOUR_SECONDS,
      lifetimes,
    });
    vi.advanceTimersByTime(2 * HOUR_MS + 1);

    expect((await stop(t, impersonation, lifetimes)).kind).toBe(
      "impersonatorSessionEnded",
    );

    expect(await sessionCount(t)).toBe(0);
  });

  test("the impersonation's refreshes keep the impersonator session from going idle", async () => {
    const t = setup();
    const lifetimes = resolveTtlConfig({
      refreshInactivityTimeoutSeconds: 30 * 60,
    });
    const admin = await signIn(t, "admin", lifetimes);
    let impersonation = await impersonate(t, admin, "alice", { lifetimes });
    // Refresh the impersonation every 20 minutes. The impersonator session
    // itself last refreshed 40 minutes before the stop, past its timeout.
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(20 * 60 * 1000);
      impersonation = expectRotated(
        await refresh(t, impersonation.refreshToken, lifetimes),
      );
    }

    const restored = expectRestored(await stop(t, impersonation, lifetimes));

    expectRotated(await refresh(t, restored.refreshToken, lifetimes));
  });

  test("ends both sessions when neither refreshed within the inactivity timeout", async () => {
    const t = setup();
    const lifetimes = resolveTtlConfig({
      refreshInactivityTimeoutSeconds: 30 * 60,
    });
    const admin = await signIn(t, "admin", lifetimes);
    const impersonation = await impersonate(t, admin, "alice", { lifetimes });
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    expect((await stop(t, impersonation, lifetimes)).kind).toBe(
      "impersonatorSessionEnded",
    );

    expect(await sessionCount(t)).toBe(0);
  });

  test("reports an impersonator session that was signed out during the grace period", async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);
    const restored = expectRestored(await stop(t, impersonation));
    await t.mutation(api.public.signOut, {
      refreshToken: restored.refreshToken,
    });

    expect((await stop(t, impersonation)).kind).toBe(
      "impersonatorSessionEnded",
    );

    expect(await sessionOf(t, impersonation)).toBeNull();
  });
});

describe("refreshing during an impersonation", () => {
  test("an impersonation session refreshes until its expiry, then both sessions end", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const expiresAt = await expiresAtOf(t, impersonation);
    vi.setSystemTime(expiresAt - 1);
    const rotated = expectRotated(await refresh(t, impersonation.refreshToken));
    // Never later than the impersonation's own end.
    expect(rotated.refreshTokenExpiresAt).toBe(expiresAt);

    vi.setSystemTime(expiresAt);

    expect((await refresh(t, rotated.refreshToken)).kind).toBe("noSession");
    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).toBeNull();
  });

  test("an impersonation ends when its impersonator session reaches its max lifetime", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    // The impersonation starts 8 minutes into the impersonator session.
    vi.advanceTimersByTime(8 * 60 * 1000);
    const impersonation = await impersonate(t, admin, "alice");
    // The app lowers the max lifetime to 10 minutes while the impersonation
    // runs. 3 minutes later the impersonator session is 11 minutes old and
    // past it, and the impersonation is 3 minutes old and not.
    const lowered = resolveTtlConfig({ sessionMaxLifetimeSeconds: 10 * 60 });
    vi.advanceTimersByTime(3 * 60 * 1000);
    const impersonationSession = (await sessionOf(t, impersonation))!;
    expect(impersonationSession._creationTime + 10 * 60 * 1000).toBeGreaterThan(
      Date.now(),
    );
    expect(impersonationSession.impersonation!.expiresAt).toBeGreaterThan(
      Date.now(),
    );

    expect((await refresh(t, impersonation.refreshToken, lowered)).kind).toBe(
      "noSession",
    );

    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).toBeNull();
  });

  test("the impersonator session still refreshes right after the start", async () => {
    const t = setup();
    const { admin } = await startImpersonation(t);
    vi.advanceTimersByTime(REFRESH_GRACE_MS);

    // A refresh that was under way when the start committed.
    expectRotated(await refresh(t, admin.refreshToken));
  });

  test("the impersonator session is suspended after that, and nothing is revoked", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    vi.advanceTimersByTime(PAST_REFRESH_GRACE_MS);

    expect((await refresh(t, admin.refreshToken)).kind).toBe("noSession");

    expect(await sessionOf(t, admin)).not.toBeNull();
    expect(await sessionOf(t, impersonation)).not.toBeNull();
    expectRotated(await refresh(t, impersonation.refreshToken));
  });

  test("the impersonator session refreshes again after a stop", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    vi.advanceTimersByTime(PAST_REFRESH_GRACE_MS);
    expect((await refresh(t, admin.refreshToken)).kind).toBe("noSession");

    const restored = expectRestored(await stop(t, impersonation));

    expectRotated(await refresh(t, restored.refreshToken));
  });

  test("a spent token of a suspended impersonator session revokes both sessions", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    const next = expectRotated(await refresh(t, admin.refreshToken));
    // Redeeming the successor spends the first token.
    const current = expectRotated(await refresh(t, next.refreshToken));
    const impersonation = await impersonate(t, current, "alice");
    vi.advanceTimersByTime(PAST_REFRESH_GRACE_MS);

    expect((await refresh(t, admin.refreshToken)).kind).toBe("noSession");

    expect(await sessionOf(t, admin)).toBeNull();
    expect(await sessionOf(t, impersonation)).toBeNull();
  });

  test("a dropped token of a suspended impersonator session revokes both sessions", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    // Two refreshes from the same token, then one of the two is redeemed,
    // which drops the other.
    const kept = expectRotated(await refresh(t, admin.refreshToken));
    const dropped = expectRotated(await refresh(t, admin.refreshToken));
    const current = expectRotated(await refresh(t, kept.refreshToken));
    const impersonation = await impersonate(t, current, "alice");
    vi.advanceTimersByTime(PAST_REFRESH_GRACE_MS);

    expect((await refresh(t, dropped.refreshToken)).kind).toBe("noSession");

    expect(await sessionOf(t, admin)).toBeNull();
    expect(await sessionOf(t, impersonation)).toBeNull();
  });
});

describe("the two sessions of an impersonation end together", () => {
  test("signing out of the impersonator session ends the impersonation", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    await t.mutation(api.public.signOut, { refreshToken: admin.refreshToken });

    expect(await sessionOf(t, impersonation)).toBeNull();
    expect((await refresh(t, impersonation.refreshToken)).kind).toBe(
      "noSession",
    );
  });

  test("signing out of the impersonation ends the impersonator session", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    await t.mutation(api.public.signOut, {
      refreshToken: impersonation.refreshToken,
    });

    expect(await sessionOf(t, admin)).toBeNull();
    expect(await sessionCount(t)).toBe(1);
  });

  test("revoking either session revokes the other", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);

    expect(
      await t.mutation(api.public.revokeSessions, {
        sessionIds: [sessionIdOf(admin)],
      }),
    ).toEqual([sessionIdOf(admin)]);
    expect(await sessionOf(t, impersonation)).toBeNull();

    const again = await startImpersonation(t);
    await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(again.impersonation)],
    });
    expect(await sessionOf(t, again.admin)).toBeNull();
  });

  test("revoking both sessions of an impersonation returns both ids", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const sessionIds = [sessionIdOf(impersonation), sessionIdOf(admin)];

    expect(
      await t.mutation(api.public.revokeSessions, {
        sessionIds: [...sessionIds, sessionIdOf(admin)],
      }),
    ).toEqual(sessionIds);
  });

  test("reuse detection on the impersonation revokes the impersonator session", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const next = expectRotated(await refresh(t, impersonation.refreshToken));
    expectRotated(await refresh(t, next.refreshToken));

    // The first token is spent now.
    expect((await refresh(t, impersonation.refreshToken)).kind).toBe(
      "noSession",
    );

    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).toBeNull();
  });

  test("evicting the impersonation past the session cap ends the impersonator session", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    const impersonation = await impersonate(t, admin, "alice");
    // The impersonation never refreshes, so it refreshed longest ago.
    for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
      vi.advanceTimersByTime(1000);
      await signIn(t, "alice");
    }

    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).toBeNull();
  });

  test("a stopped impersonation is deleted alone", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    expectRestored(await stop(t, impersonation));

    await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(impersonation)],
    });

    expect(await sessionOf(t, admin)).not.toBeNull();
  });

  test("revoking the impersonator session ends its live impersonation, beside a stopped one", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const restored = expectRestored(await stop(t, impersonation));
    // A second impersonation, inside the grace period of the first stop.
    const second = await impersonate(t, restored, "bob");

    await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(admin)],
    });

    expect(await sessionOf(t, second)).toBeNull();
  });

  test("impersonate and stopImpersonation update stored ttlConfig", async () => {
    const t = setup();
    const admin = await signIn(t, "admin");
    const impersonation = await impersonate(t, admin, "alice", {
      lifetimes: resolveTtlConfig({
        refreshInactivityTimeoutSeconds: 2 * 60 * 60,
        sessionMaxLifetimeSeconds: 4 * 60 * 60,
      }),
    });
    const storedAfterStart = await t.run(async (ctx) =>
      (await ctx.db.query("ttlConfig").collect()).map((row) => [
        row.refreshInactivityTimeoutSeconds,
        row.sessionMaxLifetimeSeconds,
      ]),
    );
    expect(storedAfterStart).toEqual([[2 * 60 * 60, 4 * 60 * 60]]);

    expectRestored(
      await stop(
        t,
        impersonation,
        resolveTtlConfig({
          refreshInactivityTimeoutSeconds: 3 * 60 * 60,
          sessionMaxLifetimeSeconds: 5 * 60 * 60,
        }),
      ),
    );
    const storedAfterStop = await t.run(async (ctx) =>
      (await ctx.db.query("ttlConfig").collect()).map((row) => [
        row.refreshInactivityTimeoutSeconds,
        row.sessionMaxLifetimeSeconds,
      ]),
    );
    expect(storedAfterStop).toEqual([[3 * 60 * 60, 5 * 60 * 60]]);
  });

  test("stopping after the impersonation expiresAt ends both sessions even when the impersonator session is still live", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    const expiresAt = await expiresAtOf(t, impersonation);
    vi.setSystemTime(expiresAt);

    expect(await stop(t, impersonation)).toEqual({
      kind: "impersonatorSessionEnded",
    });
    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).toBeNull();
  });

  test("stopping retires the impersonator's pre-stop redeemed token so replaying it revokes the restored session", async () => {
    const t = setup();
    const adminInitial = await signIn(t, "admin");
    // Refresh once before impersonating so admin has both a redeemed token
    // (adminInitial) and an issued token (adminAfterRefresh).
    const adminAfterRefresh = expectRotated(
      await refresh(t, adminInitial.refreshToken),
    );
    const impersonation = await impersonate(t, adminAfterRefresh, "alice");
    const restored = expectRestored(await stop(t, impersonation));

    // A retry before any restoration token is redeemed still works.
    expectRestored(await stop(t, impersonation));

    // Replaying the pre-stop redeemed token triggers reuse detection and
    // revokes the restored impersonator session.
    expect((await refresh(t, adminInitial.refreshToken)).kind).toBe(
      "noSession",
    );
    expect(await sessionOf(t, restored)).toBeNull();
  });

  test("a stopped impersonation is refused by getSession, refresh, and repeated stop once the grace deadline passes, even before scheduled deletion runs", async () => {
    const t = setup();
    const { admin, impersonation } = await startImpersonation(t);
    expectRestored(await stop(t, impersonation));
    const stoppedAt = (await sessionOf(t, impersonation))!.impersonation!
      .stoppedAt!;

    // Move the clock to the exact grace deadline without firing scheduled
    // timers (simulating a delayed deleteStoppedImpersonation).
    vi.setSystemTime(stoppedAt + IMPERSONATION_STOP_GRACE_MS);

    expect(
      await t.query(api.public.getSession, {
        sessionId: sessionIdOf(impersonation),
      }),
    ).toBeNull();
    expect(await stop(t, impersonation)).toEqual({
      kind: "notImpersonating",
    });
    expect(await sessionOf(t, impersonation)).toBeNull();
    expect(await sessionOf(t, admin)).not.toBeNull();

    // Same deadline check on refresh with scheduled deletion still pending.
    const second = await impersonate(t, admin, "bob");
    expectRestored(await stop(t, second));
    const secondStoppedAt = (await sessionOf(t, second))!.impersonation!
      .stoppedAt!;
    vi.setSystemTime(secondStoppedAt + IMPERSONATION_STOP_GRACE_MS);

    expect((await refresh(t, second.refreshToken)).kind).toBe("noSession");
    expect(await sessionOf(t, second)).toBeNull();
    expect(await sessionOf(t, admin)).not.toBeNull();
  });
});
