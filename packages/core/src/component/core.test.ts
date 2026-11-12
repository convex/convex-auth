import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { api } from "./_generated/api.ts";
import type { Doc, Id } from "./_generated/dataModel.ts";
import schema from "./schema.ts";
import * as testApp from "./testApp.fixture.ts";
import {
  type AuthClaims,
  type TokenBundle,
  type RefreshResult,
} from "../lib/types.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { resolveTtlConfig } from "../lib/ttl.ts";
import {
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
  REFRESH_GRACE_MS,
  SPENT_TOKEN_HORIZON_MS,
  MAX_SESSIONS_PER_USER,
} from "./sessions.ts";

/**
 * The component's modules, and the test-only `testApp` module. The fixture file
 * has two dots in its name, thus the Convex bundler and codegen skip it, and it
 * is not deployed with the component. It is injected here as `testApp.ts`, so
 * that its functions have the `testApp:<name>` handles.
 */
const modules = {
  ...import.meta.glob(["./**/*.ts", "!./**/*.fixture.ts"]),
  "./testApp.ts": async () => testApp,
};

// The core mints access tokens with the deployment's key via
// `ctx.auth.signJwt`. convex-test signs them with a key of its own per
// `convexTest` instance, and `t.jwks()` returns the matching JWKS, which is what
// the deployment serves at `.well-known/jwks.json` in production. The suite
// runs the component as the root app, so `iss` is the bare deployment origin
// (a real deployment would use `.../components/auth`); with no
// `CONVEX_CLOUD_URL` set, convex-test uses its default origin.
const ISSUER =
  process.env.CONVEX_CLOUD_URL ?? "https://some-deployment.convex.cloud";
const AUDIENCE = "convex-auth";
const CREATE_USER_HANDLE = "testApp:createUser";
/** The path of the component that authenticated the users of the tests. */
const COMPONENT_PATH = "authPassword";
const ON_SIGN_IN_HANDLE = "testApp:onSignIn";
const THROWING_ON_SIGN_IN_HANDLE = "testApp:onSignInThatThrows";

/** Verify an access token against the test deployment's JWKS. */
async function verifyAccessToken(t: ConvexTestApi, token: string) {
  const jwks = createLocalJWKSet(await t.jwks());
  return await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
}

function claims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    method: "usernamePassword",
    profile: { name: "Alice" },
    ...overrides,
  };
}

function setup(options?: { transactionLimits?: boolean }) {
  return convexTest({ schema, modules, ...options });
}

type ConvexTestApi = ReturnType<typeof setup>;

/**
 * The lifetimes `setupConvexAuth` passes when the app overrides the given ones,
 * as the component always receives a complete configuration.
 */
function ttl(overrides: Parameters<typeof resolveTtlConfig>[0] = {}) {
  return resolveTtlConfig(overrides);
}

/** The lifetimes `setupConvexAuth` passes when the app overrides none. */
const DEFAULT_TTL = ttl();

/**
 * Run the scheduled functions to completion, such as the erasure of a deleted
 * session's refresh tokens (see `deleteSession`), with or without fake timers.
 */
async function finishScheduledFunctions(t: ConvexTestApi) {
  await t.finishAllScheduledFunctions(() => {
    if (vi.isFakeTimers()) vi.runAllTimers();
  });
}

/** Establish a brand new identity: its app user and a session. */
async function signUp(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public._internal_dangerous_signUp, {
    claims: c,
    componentPath: COMPONENT_PATH,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    ...DEFAULT_TTL,
  });
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: ConvexTestApi, c: AuthClaims, userId: string) {
  return await t.mutation(api.public._internal_dangerous_signIn, {
    claims: c,
    componentPath: COMPONENT_PATH,
    userId,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    ...DEFAULT_TTL,
  });
}

/** Assert a refresh rotated the token, and narrow to the new bundle. */
function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

/** Exchange a refresh token, as a client rotating its session does. */
async function refresh(t: ConvexTestApi, refreshToken: string) {
  return await t.mutation(api.public.refresh, {
    refreshToken,
    ...DEFAULT_TTL,
  });
}

const HOUR_MS = 60 * 60 * 1000;

/** How many sessions currently exist. */
async function sessionCount(t: ConvexTestApi) {
  return await t.run(
    async (ctx) => (await ctx.db.query("sessions").collect()).length,
  );
}

/** A session's refresh tokens in the given states, oldest first. */
async function tokensInState(
  t: ConvexTestApi,
  ...states: Doc<"refreshTokens">["state"][]
) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("refreshTokens").collect()).filter((r) =>
      states.includes(r.state),
    ),
  );
}

/** The hashes of the spent and dropped tokens, oldest first. */
async function retiredHashes(t: ConvexTestApi) {
  return (await tokensInState(t, "spent", "dropped")).map((r) => r.hash);
}

/** The spent and dropped tokens with how each was retired, oldest first. */
async function retiredTokens(t: ConvexTestApi) {
  return (await tokensInState(t, "spent", "dropped")).map((r) => ({
    hash: r.hash,
    state: r.state,
  }));
}

/** The hashes of the tokens no one has presented yet, oldest first. */
async function issuedHashes(t: ConvexTestApi) {
  return (await tokensInState(t, "issued")).map((r) => r.hash);
}

/** The hash of the session's redeemed token, if it has one. */
async function redeemedHash(t: ConvexTestApi) {
  const redeemed = await tokensInState(t, "redeemed");
  expect(redeemed.length).toBeLessThanOrEqual(1);
  return redeemed[0]?.hash;
}

describe("sessions and created user IDs", () => {
  async function createdUserIds(t: ConvexTestApi) {
    return (
      await t.run(async (ctx) => ctx.db.query("createdUserIds").collect())
    ).map((row) => row.userId);
  }

  test("a session records the path of the component that authenticated the user", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const { payload } = await verifyAccessToken(t, bundle.accessToken);
    const session = await t.run(async (ctx) =>
      ctx.db.get(payload.sub as Id<"sessions">),
    );
    expect(session).toMatchObject({ component: COMPONENT_PATH });
  });

  test("signUp, signIn, and signUpWithoutSession record the user ID once", async () => {
    const t = setup();
    const { userId } = await signUp(t, claims());
    await signIn(t, claims(), userId);
    await signIn(t, claims(), "someone");
    const { userId: pending } = await t.mutation(
      api.public._internal_dangerous_signUpWithoutSession,
      { claims: claims(), createUserHandle: CREATE_USER_HANDLE },
    );
    expect((await createdUserIds(t)).sort()).toEqual(
      [userId, "someone", pending].sort(),
    );
  });

  test("markUserIdCreated records a user ID once, and refuses an empty one", async () => {
    const t = setup();
    await t.mutation(api.public.markUserIdCreated, { userId: "imported" });
    await t.mutation(api.public.markUserIdCreated, { userId: "imported" });
    expect(await createdUserIds(t)).toEqual(["imported"]);
    await expect(
      t.mutation(api.public.markUserIdCreated, { userId: "" }),
    ).rejects.toThrow("empty user ID");
  });
});

describe("signUp", () => {
  test("creates a session and mints a verifiable JWT", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect(bundle.userId).toBeTruthy();
    expect(bundle.refreshToken).toBeTruthy();

    const session = await t.run(
      async (ctx) => await ctx.db.query("sessions").unique(),
    );
    expect(session).not.toBeNull();
    const sessionId = session!._id;
    // The session holds the user id and the path of the component that
    // authenticated the user, and nothing else about the identity.
    expect(session).toMatchObject({
      userId: bundle.userId,
      component: COMPONENT_PATH,
    });

    // The access token verifies against the deployment JWKS with the right
    // claims.
    const { payload } = await verifyAccessToken(t, bundle.accessToken);
    // The subject is the session, not the user: the app resolves the user
    // through the session.
    expect(payload.sub).toBe(sessionId);
    expect(payload.exp! * 1000).toBeGreaterThan(Date.now());
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThan(payload.exp! * 1000);
  });

  test("invokes the app's createUser with the claims, then onSignIn", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const bundle = await signUp(t, claims({ profile: { name: "Alice" } }));

    expect(testApp.getCreateUserCalls()).toEqual([
      {
        method: {
          name: "usernamePassword",
          profile: { name: "Alice" },
        },
      },
    ]);
    // A first sign-in is still a sign-in, so onSignIn runs too, with the id
    // createUser just returned. Per-sign-in work has one home.
    expect(testApp.getOnSignInCalls()).toEqual([
      {
        method: {
          name: "usernamePassword",
          profile: { name: "Alice" },
        },
        userId: bundle.userId,
      },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const bundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...DEFAULT_TTL,
    });

    // The bundle carries the id returned by the app's createUser.
    expect(bundle.userId).toBe("user1");
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
  });

  test("an onSignIn that throws rolls back the user it just created", async () => {
    const t = setup();

    await expect(
      t.mutation(api.public._internal_dangerous_signUp, {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        createUserHandle: CREATE_USER_HANDLE,
        onSignInHandle: THROWING_ON_SIGN_IN_HANDLE,
        ...DEFAULT_TTL,
      }),
    ).rejects.toThrow(/no sign-ins for you/);

    // This can't check that the user rolls back: the fixture's createUser keeps
    // no rows. An app's users row is a write of the same mutation, so it rolls
    // back with it. What the core owns is checked here: onSignIn runs before
    // the session is minted, so none exists.
    expect(await sessionCount(t)).toBe(0);
  });
});

describe("signIn", () => {
  test("mints a fresh session for the given user", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    const second = await signIn(
      t,
      claims({ profile: { name: "Alice 2.0" } }),
      first.userId,
    );

    expect(second.userId).toBe(first.userId);
    const sessions = await t.run(
      async (ctx) => await ctx.db.query("sessions").collect(),
    );
    expect(sessions).toHaveLength(2);
    expect(
      sessions.map(({ userId, component }) => ({ userId, component })),
    ).toEqual([
      { userId: first.userId, component: COMPONENT_PATH },
      { userId: first.userId, component: COMPONENT_PATH },
    ]);
  });

  test("invokes the app's onSignIn with the resolved user id and latest claims", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    await signIn(t, claims({ profile: { name: "Alice 2.0" } }), first.userId);

    // The app gets the known id and the fresh profile to sync from. createUser
    // ran once, for the sign-up; onSignIn ran for both.
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    expect(testApp.getOnSignInCalls()).toHaveLength(2);
    expect(testApp.getOnSignInCalls()[1]).toEqual({
      method: {
        name: "usernamePassword",
        profile: { name: "Alice 2.0" },
      },
      userId: first.userId,
    });
  });

  test("mints the session without notifying an app that attached no onSignIn", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    testApp.resetUserCallbackCalls();

    // No `onSignInHandle` is what an app that left `onSignIn` out sends.
    const bundle = await t.mutation(api.public._internal_dangerous_signIn, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      userId: first.userId,
      ...DEFAULT_TTL,
    });

    expect(bundle.userId).toBe(first.userId);
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
  });

  test("refuses an empty user id", async () => {
    const t = setup();

    // An empty string must never be accepted as a user id.
    await expect(signIn(t, claims(), "")).rejects.toThrow(/no user id/i);
    expect(await sessionCount(t)).toBe(0);
  });
});

describe("signUpWithoutSession", () => {
  test("creates the user, but no session", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const { userId } = await t.mutation(
      api.public._internal_dangerous_signUpWithoutSession,
      {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
      },
    );

    // The id returned by the app's createUser.
    expect(userId).toBe("user1");
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    // No sign-in happened, so onSignIn does not run, and no session was
    // minted.
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
    expect(await sessionCount(t)).toBe(0);
  });

  test("a later signIn with the user id mints a session", async () => {
    const t = setup();
    const { userId } = await t.mutation(
      api.public._internal_dangerous_signUpWithoutSession,
      {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
      },
    );

    const bundle = await signIn(t, claims(), userId);
    expect(bundle.userId).toBe(userId);
    expect(await sessionCount(t)).toBe(1);
  });
});

describe("refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("rotates the refresh token and mints a fresh access token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    expect(rotated.refreshToken).not.toBe(bundle.refreshToken);
    expect(rotated.userId).toBe(bundle.userId);

    // The newly minted refresh token works for the next rotation.
    const again = expectRotated(await refresh(t, rotated.refreshToken));
    expect(again.refreshToken).not.toBe(rotated.refreshToken);
  });

  test("sign-in issues a token that its first refresh redeems", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expect(await redeemedHash(t)).toBeUndefined();
    expect(await issuedHashes(t)).toEqual([
      await sha256Hex(bundle.refreshToken),
    ]);

    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Nothing is spent yet: if this response had been lost, the client would
    // still hold a token that works.
    expect(await redeemedHash(t)).toBe(await sha256Hex(bundle.refreshToken));
    expect(await issuedHashes(t)).toEqual([
      await sha256Hex(successor.refreshToken),
    ]);
    expect(await retiredHashes(t)).toEqual([]);
  });

  test("a refresh whose response was lost can be retried with the same token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const lost = expectRotated(await refresh(t, bundle.refreshToken));
    // The client never saw `lost` and presents its token again.
    const retry = expectRotated(await refresh(t, bundle.refreshToken));
    expect(retry.refreshToken).not.toBe(lost.refreshToken);

    // The retry's successor carries on, and the lost one is dropped unused.
    expectRotated(await refresh(t, retry.refreshToken));
    expect(await sessionCount(t)).toBe(1);
    expect(await retiredTokens(t)).toEqual([
      { hash: await sha256Hex(bundle.refreshToken), state: "spent" },
      { hash: await sha256Hex(lost.refreshToken), state: "dropped" },
    ]);
  });

  test("first use of an issued token redeems it and spends the one before", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    const next = expectRotated(await refresh(t, successor.refreshToken));

    expect(await redeemedHash(t)).toBe(await sha256Hex(successor.refreshToken));
    expect(await issuedHashes(t)).toEqual([await sha256Hex(next.refreshToken)]);
    expect(await retiredTokens(t)).toEqual([
      { hash: await sha256Hex(bundle.refreshToken), state: "spent" },
    ]);
  });

  test("racers sharing the redeemed token each get an issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    const racers: TokenBundle[] = [];
    for (let i = 0; i < 3; i++) {
      racers.push(expectRotated(await refresh(t, bundle.refreshToken)));
    }
    expect(new Set(racers.map((r) => r.refreshToken)).size).toBe(3);

    // The client keeps whichever response it saw last; that one is redeemed, and
    // the others are dropped without anyone ever presenting them.
    expectRotated(await refresh(t, racers[2].refreshToken));
    expect(await sessionCount(t)).toBe(1);
    expect(
      (await retiredTokens(t)).filter((r) => r.state === "dropped"),
    ).toHaveLength(2);
  });

  test("racers sharing an issued token both succeed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Parallel SSR loaders carrying the same new cookie. The first redeems
    // it; the second finds it already redeemed.
    const first = expectRotated(await refresh(t, successor.refreshToken));
    const second = expectRotated(await refresh(t, successor.refreshToken));
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await sessionCount(t)).toBe(1);
    expect(await redeemedHash(t)).toBe(await sha256Hex(successor.refreshToken));
  });

  test("reports no session and clears it once the refresh token has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const bundle = await signUp(t, claims());

    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Past the default 30-day inactivity timeout.
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);

    const result = await refresh(t, bundle.refreshToken);
    expect(result.kind).toBe("noSession");

    // The dead session was removed in the same transaction, tokens and all.
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
  });

  test("reports no session for an expired issued token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Past the default 30-day inactivity timeout.
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);

    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("a lowered inactivity timeout expires tokens issued under the old one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    // Issued under the default 30-day inactivity timeout.
    const bundle = await signUp(t, claims());
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    // Two hours old: dead under a one-hour inactivity timeout, though the
    // 30-day one it was issued under has days to go.
    const result = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      ...ttl({
        refreshInactivityTimeoutSeconds: 60 * 60,
      }),
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a lowered inactivity timeout expires the redeemed token a retry would present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const bundle = await signUp(t, claims());
    // Redeems the sign-in token. Suppose the response is lost, so the client
    // keeps presenting the redeemed token.
    expectRotated(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    const result = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      ...ttl({
        refreshInactivityTimeoutSeconds: 60 * 60,
      }),
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("refuses a session past its max lifetime, however recently it refreshed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const lifetimes = ttl({
      refreshInactivityTimeoutSeconds: 60 * 60,
      sessionMaxLifetimeSeconds: 2 * 60 * 60,
    });
    let bundle: TokenBundle = await t.mutation(
      api.public._internal_dangerous_signUp,
      {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        createUserHandle: CREATE_USER_HANDLE,
        ...lifetimes,
      },
    );
    // Refresh every half hour, well within the inactivity timeout, until the
    // session is just short of its max lifetime.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(30 * 60 * 1000);
      bundle = expectRotated(
        await t.mutation(api.public.refresh, {
          refreshToken: bundle.refreshToken,
          ...lifetimes,
        }),
      );
    }
    // Just past the two-hour max lifetime.
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);

    const result = await t.mutation(api.public.refresh, {
      refreshToken: bundle.refreshToken,
      ...lifetimes,
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a lowered max lifetime ends a session created before the change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    // Created under the default 30-day max lifetime.
    const bundle = await signUp(t, claims());
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    // Refresh under the old config so that the lowered inactivity timeout
    // can't end the session.
    const fresh = expectRotated(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(60 * 1000);

    const result = await t.mutation(api.public.refresh, {
      refreshToken: fresh.refreshToken,
      ...ttl({
        sessionMaxLifetimeSeconds: 60 * 60,
      }),
    });
    expect(result.kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });

  test("a redeemed token's inactivity counts from the session's newest token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 60 * 60 });
    const bundle: TokenBundle = await t.mutation(
      api.public._internal_dangerous_signUp,
      {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        createUserHandle: CREATE_USER_HANDLE,
        ...lifetimes,
      },
    );
    // The refresh commits, but the client never gets the response.
    vi.advanceTimersByTime(50 * 60 * 1000);
    expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...lifetimes,
      }),
    );
    // The retried token is past the timeout, but the session last refreshed
    // 20 minutes ago.
    vi.advanceTimersByTime(20 * 60 * 1000);

    expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...lifetimes,
      }),
    );
    expect(await sessionCount(t)).toBe(1);
  });

  test("reports no session for an unknown refresh token", async () => {
    const t = setup();
    const result = await refresh(t, "not-a-real-token");
    expect(result.kind).toBe("noSession");
  });

  test("an unknown token revokes nothing", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect((await refresh(t, "not-a-real-token")).kind).toBe("noSession");

    // Revoking on an unrecognized token would let anyone sign anyone else out
    // by presenting a made-up string. The live session is untouched.
    expect(await sessionCount(t)).toBe(1);
    expect(expectRotated(await refresh(t, bundle.refreshToken))).toBeTruthy();
  });
});

describe("refresh-token reuse detection", () => {
  // `retiredAt` is what dates a retired hash, and it is stamped from the
  // clock, so aging one past the detection horizon means moving the clock.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a lost response is recoverable after any gap", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // The refresh commits, then the laptop sleeps before the response lands.
    expectRotated(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    // Hours later, the token the client still holds is still redeemed.
    const recovered = expectRotated(await refresh(t, bundle.refreshToken));
    expectRotated(await refresh(t, recovered.refreshToken));
    expect(await sessionCount(t)).toBe(1);
  });

  test("a spent token revokes the session", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // The thief refreshes and uses its successor, which spends the token the
    // victim holds.
    const thief = expectRotated(await refresh(t, stolen.refreshToken));
    const thiefNext = expectRotated(await refresh(t, thief.refreshToken));
    vi.advanceTimersByTime(60_000);

    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await retiredHashes(t)).toEqual([]);
    expect(await issuedHashes(t)).toEqual([]);

    // Revocation is mutual: the thief's token stops working too, which is the
    // whole point — otherwise they keep renewing the session forever.
    expect((await refresh(t, thiefNext.refreshToken)).kind).toBe("noSession");
  });

  test("a dropped token revokes the session", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // Thief and victim both refresh from the same token.
    const victim = expectRotated(await refresh(t, stolen.refreshToken));
    const thief = expectRotated(await refresh(t, stolen.refreshToken));

    // The victim redeems first, which drops the thief's successor.
    const victimNext = expectRotated(await refresh(t, victim.refreshToken));

    // Whoever redeems second has forked from the first.
    expect((await refresh(t, thief.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, victimNext.refreshToken)).kind).toBe("noSession");
  });

  test("detects a replay several rotations back", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());

    // A thief who keeps rotating would evict the victim's hash from any
    // fixed-size history. Retention is by age, so depth doesn't save them.
    let latest = stolen;
    for (let i = 0; i < 6; i++) {
      latest = expectRotated(await refresh(t, latest.refreshToken));
    }
    // Each rotation after the first spends the token redeemed before it.
    expect(await retiredHashes(t)).toHaveLength(5);
    vi.advanceTimersByTime(60_000);

    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, latest.refreshToken)).kind).toBe("noSession");
  });

  test("a replay after the session is already gone is a no-op", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    expectRotated(await refresh(t, rotated.refreshToken));
    await t.mutation(api.public.signOut, {
      refreshToken: rotated.refreshToken,
    });

    // Two replays racing each other both resolve a session the other deleted.
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("pruning retires spent hashes, and with them the detection", async () => {
    const t = setup();
    const stolen = await signUp(t, claims());
    const live = expectRotated(await refresh(t, stolen.refreshToken));
    const next = expectRotated(await refresh(t, live.refreshToken));
    expect(await retiredHashes(t)).toEqual([
      await sha256Hex(stolen.refreshToken),
    ]);

    vi.advanceTimersByTime(SPENT_TOKEN_HORIZON_MS + 1);
    // The next redemption pays for the row it adds by erasing the expired one.
    const after = expectRotated(await refresh(t, next.refreshToken));
    expect(await retiredHashes(t)).toEqual([
      await sha256Hex(live.refreshToken),
    ]);

    // Past the horizon the stolen token is merely unknown, so it revokes
    // nothing. Detection is best-effort by construction.
    expect((await refresh(t, stolen.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(1);
    expectRotated(await refresh(t, after.refreshToken));
  });

  test(`revokes the session at the standard limit of ${STANDARD_ISSUED_REFRESH_TOKEN_LIMIT} issued tokens`, async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
      expectRotated(await refresh(t, bundle.refreshToken));
      vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);
    }

    // That many lost responses in a row looks more like someone replaying the
    // redeemed token than like a client on a bad network.
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("redeeming an issued token resets the count", async () => {
    const t = setup();
    let token = (await signUp(t, claims())).refreshToken;

    for (let round = 0; round < 3; round++) {
      let last: TokenBundle | undefined;
      for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
        last = expectRotated(await refresh(t, token));
        vi.advanceTimersByTime(REFRESH_GRACE_MS + 1);
      }
      token = last!.refreshToken;
    }
    expect(await sessionCount(t)).toBe(1);
  });

  test("concurrent refreshes right after a redemption don't count", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // An SSR page load: more requests carrying the same cookie than the cap
    // arrive at once. The first redeems the token, the rest present it redeemed.
    const burst = await Promise.all(
      Array.from({ length: STANDARD_ISSUED_REFRESH_TOKEN_LIMIT + 3 }, () =>
        refresh(t, bundle.refreshToken),
      ),
    );
    burst.forEach(expectRotated);
    expect(await sessionCount(t)).toBe(1);

    // Whichever response the browser kept carries on as usual.
    vi.advanceTimersByTime(60_000);
    expectRotated(await refresh(t, expectRotated(burst.at(-1)!).refreshToken));
    expect(await sessionCount(t)).toBe(1);
  });

  test("the grace doesn't extend past the redemption", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expectRotated(await refresh(t, bundle.refreshToken));

    // Replays spaced inside the grace from each other still run out, since the
    // grace counts from the redemption.
    const results: RefreshResult["kind"][] = [];
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(REFRESH_GRACE_MS - 1000);
      const result = await refresh(t, bundle.refreshToken);
      results.push(result.kind);
      if (result.kind === "noSession") break;
    }
    expect(results.at(-1)).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
  });
});

describe("signOut", () => {
  test("revokes the session so it can no longer be refreshed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    await t.mutation(api.public.signOut, {
      refreshToken: bundle.refreshToken,
    });
    const remaining = await t.run(
      async (ctx) => (await ctx.db.query("sessions").collect()).length,
    );
    expect(remaining).toBe(0);

    // Refreshing the signed-out session is no longer possible.
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("revokes when given an issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));

    // What a client holds between refreshes: the issued token it hasn't used yet.
    await t.mutation(api.public.signOut, {
      refreshToken: rotated.refreshToken,
    });

    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await issuedHashes(t)).toEqual([]);
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
  });

  test("revokes when given a spent token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    const next = expectRotated(await refresh(t, rotated.refreshToken));

    // A tab that signs out just after a sibling refreshed presents the token
    // it still holds. Matching only live hashes would no-op here and leave the
    // session alive after an explicit sign-out.
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });

    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    expect(await retiredHashes(t)).toEqual([]);
    expect((await refresh(t, next.refreshToken)).kind).toBe("noSession");
  });

  test("erases the session's refresh tokens along with it", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    const next = expectRotated(await refresh(t, rotated.refreshToken));
    expect(await retiredHashes(t)).toHaveLength(1);
    expect(await issuedHashes(t)).toHaveLength(1);

    await t.mutation(api.public.signOut, { refreshToken: next.refreshToken });

    // The tokens are erased in the background, right after the session.
    await finishScheduledFunctions(t);
    expect(await retiredHashes(t)).toEqual([]);
    expect(await issuedHashes(t)).toEqual([]);
  });

  test("a token whose session is gone reports no session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = setup();
      const bundle = await signUp(t, claims());
      const rotated = expectRotated(await refresh(t, bundle.refreshToken));
      const next = expectRotated(await refresh(t, rotated.refreshToken));

      await t.mutation(api.public.signOut, { refreshToken: next.refreshToken });

      // Before the tokens are erased, each one still names the session, which
      // ended already. A spent one isn't a sign of a fork then: there is nothing
      // left to revoke.
      expect(await issuedHashes(t)).toHaveLength(1);
      expect((await refresh(t, next.refreshToken)).kind).toBe("noSession");
      expect((await refresh(t, bundle.refreshToken)).kind).toBe("noSession");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("is idempotent — signing out an already-revoked token does not throw", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });
    await expect(
      t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken }),
    ).resolves.toBeNull();
  });
});

/** The session id carried in the bundle's access token (`sub` claim). */
function sessionIdOf(bundle: TokenBundle): string {
  return decodeJwt(bundle.accessToken).sub!;
}

describe("listSessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("lists every session of the user", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims(), bundle.userId);

    const sessions = await t.query(api.public.listSessions, {
      userId: bundle.userId,
    });
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      [sessionIdOf(bundle), sessionIdOf(otherBundle)].sort(),
    );
  });

  test("lists the newest session first", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    const second = await signIn(t, claims(), first.userId);
    const third = await signIn(t, claims(), first.userId);

    const sessions = await t.query(api.public.listSessions, {
      userId: first.userId,
    });
    expect(sessions.map((s) => s.sessionId)).toEqual(
      [third, second, first].map(sessionIdOf),
    );
  });

  test("lists only the sessions of the given user", async () => {
    const t = setup();
    const aliceBundle = await signUp(t, claims());
    await signUp(t, claims({ profile: { name: "Bob" } }));

    const sessions = await t.query(api.public.listSessions, {
      userId: aliceBundle.userId,
    });
    expect(sessions.map((s) => s.sessionId)).toEqual([
      sessionIdOf(aliceBundle),
    ]);
  });

  test("reports when the session's newest refresh token was issued", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const bundle = await signUp(t, claims());
    vi.advanceTimersByTime(60_000);
    const refreshedAt = Date.now();
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));

    const sessions = await t.query(api.public.listSessions, {
      userId: bundle.userId,
    });
    expect(sessions).toEqual([
      {
        sessionId: sessionIdOf(rotated),
        creationTime: expect.any(Number),
        lastRefreshedAt: refreshedAt,
      },
    ]);
  });

  test("includes a session whose refresh tokens have all expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const stale = await signUp(t, claims());
    // Past the default 30-day inactivity timeout.
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    const fresh = await signIn(t, claims(), stale.userId);

    const sessions = await t.query(api.public.listSessions, {
      userId: stale.userId,
    });
    expect(sessions.map((s) => s.sessionId)).toEqual(
      [fresh, stale].map(sessionIdOf),
    );
  });

  test("no token outlives one inactivity timeout past the session's lastRefreshedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const bundle = await signUp(t, claims());
    // Redeem the sign-in token, then present it again twice, as a client whose
    // responses were lost would: the session has two issued siblings.
    expectRotated(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(60_000);
    // Issued under the default 30-day inactivity timeout.
    const older = expectRotated(await refresh(t, bundle.refreshToken));
    vi.advanceTimersByTime(60_000);
    // Issued after the timeout was lowered to an hour.
    expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...ttl({
          refreshInactivityTimeoutSeconds: oneHourSeconds,
        }),
      }),
    );

    const [listed] = await t.query(api.public.listSessions, {
      userId: bundle.userId,
    });
    expect(Math.floor(listed.lastRefreshedAt)).toBe(Date.now());

    // Once past it, the older sibling, issued under the longer timeout, can't
    // refresh the session either.
    vi.setSystemTime(Math.ceil(listed.lastRefreshedAt + oneHourSeconds * 1000));
    const result = await t.mutation(api.public.refresh, {
      refreshToken: older.refreshToken,
      ...ttl({
        refreshInactivityTimeoutSeconds: oneHourSeconds,
      }),
    });
    expect(result.kind).toBe("noSession");
  });

  test("leaves out, with a warning, a session with no issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims(), bundle.userId);
    // Not a state the token lifecycle reaches; forced here to cover the guard.
    await t.run(async (ctx) => {
      const tokens = await ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q) =>
          q.eq("sessionId", sessionIdOf(otherBundle) as Id<"sessions">),
        )
        .collect();
      for (const row of tokens) {
        await ctx.db.delete("refreshTokens", row._id);
      }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sessions = await t.query(api.public.listSessions, {
        userId: bundle.userId,
      });
      expect(sessions.map((s) => s.sessionId)).toEqual([sessionIdOf(bundle)]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("has no issued refresh token"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("returns nothing for a user with no sessions", async () => {
    const t = setup();
    expect(
      await t.query(api.public.listSessions, { userId: "nobody" }),
    ).toEqual([]);
  });
});

describe(`the cap of ${MAX_SESSIONS_PER_USER} sessions per user`, () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Sign the user in until they have `count` sessions, a second apart. */
  async function signInUntil(t: ConvexTestApi, count: number) {
    const bundles = [await signUp(t, claims())];
    while (bundles.length < count) {
      vi.advanceTimersByTime(1000);
      bundles.push(await signIn(t, claims(), bundles[0].userId));
    }
    return bundles;
  }

  test("keeps every session up to the cap", async () => {
    const t = setup();
    await signInUntil(t, MAX_SESSIONS_PER_USER);
    expect(await sessionCount(t)).toBe(MAX_SESSIONS_PER_USER);
  });

  test("a sign-in at the cap revokes the session that refreshed longest ago", async () => {
    const t = setup();
    const [first, second, third] = await signInUntil(t, MAX_SESSIONS_PER_USER);
    // The oldest session is still in use, so the next oldest goes instead.
    vi.advanceTimersByTime(1000);
    expectRotated(await refresh(t, first.refreshToken));

    vi.advanceTimersByTime(1000);
    const newest = await signIn(t, claims(), first.userId);

    expect(await sessionCount(t)).toBe(MAX_SESSIONS_PER_USER);
    const listed = (
      await t.query(api.public.listSessions, { userId: first.userId })
    ).map((s) => s.sessionId);
    expect(listed).not.toContain(sessionIdOf(second));
    expect(listed).toContain(sessionIdOf(first));
    expect(listed).toContain(sessionIdOf(third));
    expect(listed).toContain(sessionIdOf(newest));
    expect((await refresh(t, second.refreshToken)).kind).toBe("noSession");
  });

  test("erases the revoked session's refresh tokens", async () => {
    const t = setup();
    const [first] = await signInUntil(t, MAX_SESSIONS_PER_USER);
    await signIn(t, claims(), first.userId);
    await finishScheduledFunctions(t);
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q) =>
          q.eq("sessionId", sessionIdOf(first) as Id<"sessions">),
        )
        .collect(),
    );
    expect(remaining).toEqual([]);
  });

  test("a user over the cap is brought back to it", async () => {
    const t = setup();
    const bundles = await signInUntil(t, MAX_SESSIONS_PER_USER);
    // Sessions from before the cap existed; not reachable by signing in.
    await t.run(async (ctx) => {
      const { component } = (await ctx.db.get(
        "sessions",
        sessionIdOf(bundles[0]) as Id<"sessions">,
      ))!;
      for (let i = 0; i < 2; i++) {
        const sessionId = await ctx.db.insert("sessions", {
          userId: bundles[0].userId,
          component,
        });
        await ctx.db.insert("refreshTokens", {
          hash: `extra-${i}`,
          sessionId,
          state: "issued",
        });
      }
    });

    vi.advanceTimersByTime(1000);
    const newest = await signIn(t, claims(), bundles[0].userId);

    expect(await sessionCount(t)).toBe(MAX_SESSIONS_PER_USER);
    const listed = (
      await t.query(api.public.listSessions, { userId: newest.userId })
    ).map((s) => s.sessionId);
    expect(listed).not.toContain(sessionIdOf(bundles[0]));
    expect(listed).not.toContain(sessionIdOf(bundles[1]));
    expect(listed).not.toContain(sessionIdOf(bundles[2]));
    expect(listed).toContain(sessionIdOf(newest));
  });

  test("counts only the user's own sessions", async () => {
    const t = setup();
    const bob = await signUp(t, claims({ profile: { name: "Bob" } }));
    const [first] = await signInUntil(t, MAX_SESSIONS_PER_USER);
    await signIn(t, claims(), first.userId);

    expect(
      await t.query(api.public.listSessions, { userId: bob.userId }),
    ).toHaveLength(1);
    expect(
      await t.query(api.public.listSessions, { userId: first.userId }),
    ).toHaveLength(MAX_SESSIONS_PER_USER);
  });
});

describe("revokeSessions", () => {
  test("revokes the sessions so they can no longer be refreshed", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const second = await signIn(t, claims(), bundle.userId);
    const third = await signIn(t, claims(), bundle.userId);

    const revoked = await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(second), sessionIdOf(third)],
    });
    expect(revoked.sort()).toEqual(
      [sessionIdOf(second), sessionIdOf(third)].sort(),
    );
    expect(await sessionCount(t)).toBe(1);
    expect((await refresh(t, second.refreshToken)).kind).toBe("noSession");
    expect((await refresh(t, third.refreshToken)).kind).toBe("noSession");
    expect((await refresh(t, bundle.refreshToken)).kind).toBe("rotated");
  });

  test("revokes the sessions of any user", async () => {
    const t = setup();
    const alice = await signUp(t, claims());
    const bob = await signUp(t, claims({ profile: { name: "Bob" } }));

    const revoked = await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(alice), sessionIdOf(bob)],
    });
    expect(revoked).toHaveLength(2);
    expect(await sessionCount(t)).toBe(0);
  });

  test("erases the sessions' refresh tokens", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    expectRotated(await refresh(t, bundle.refreshToken));

    await t.mutation(api.public.revokeSessions, {
      sessionIds: [sessionIdOf(bundle)],
    });
    await finishScheduledFunctions(t);
    const tokens = await t.run(
      async (ctx) => await ctx.db.query("refreshTokens").collect(),
    );
    expect(tokens).toEqual([]);
  });

  test("revokes sessions holding more refresh tokens than one transaction can delete", async () => {
    // The real limits: 16,000 writes and 32,000 reads per transaction.
    const t = setup({ transactionLimits: true });
    const bundles = [await signUp(t, claims())];
    for (let i = 1; i < 12; i++) {
      bundles.push(await signIn(t, claims(), bundles[0].userId));
    }
    // 1,500 rows each, 18,000 in all: more than one transaction may delete,
    // and more than one run of the erasure handles for a single session.
    for (const bundle of bundles) {
      await t.run(async (ctx) => {
        for (let i = 1; i < 1500; i++) {
          await ctx.db.insert("refreshTokens", {
            hash: `${sessionIdOf(bundle)}-${i}`,
            sessionId: sessionIdOf(bundle) as Id<"sessions">,
            state: "spent",
            retiredAt: Date.now(),
          });
        }
      });
    }

    const revoked = await t.mutation(api.public.revokeSessions, {
      sessionIds: bundles.map(sessionIdOf),
    });
    expect(revoked).toHaveLength(12);
    expect(await sessionCount(t)).toBe(0);
    await finishScheduledFunctions(t);
    const tokens = await t.run(
      async (ctx) => await ctx.db.query("refreshTokens").collect(),
    );
    expect(tokens).toEqual([]);
  });

  test("skips an already-revoked session id", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const otherBundle = await signIn(t, claims(), bundle.userId);
    await t.mutation(api.public.signOut, { refreshToken: bundle.refreshToken });

    expect(
      await t.mutation(api.public.revokeSessions, {
        sessionIds: [sessionIdOf(bundle), sessionIdOf(otherBundle)],
      }),
    ).toEqual([sessionIdOf(otherBundle)]);
    expect(await sessionCount(t)).toBe(0);
  });

  test("reports a repeated session id once", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    expect(
      await t.mutation(api.public.revokeSessions, {
        sessionIds: [sessionIdOf(bundle), sessionIdOf(bundle)],
      }),
    ).toEqual([sessionIdOf(bundle)]);
  });

  test("skips a malformed session id", async () => {
    const t = setup();
    await signUp(t, claims());

    expect(
      await t.mutation(api.public.revokeSessions, {
        sessionIds: ["not a session id"],
      }),
    ).toEqual([]);
    expect(await sessionCount(t)).toBe(1);
  });

  test("revokes nothing for no ids", async () => {
    const t = setup();
    await signUp(t, claims());

    expect(
      await t.mutation(api.public.revokeSessions, { sessionIds: [] }),
    ).toEqual([]);
    expect(await sessionCount(t)).toBe(1);
  });
});

describe("token lifetime configuration", () => {
  test("honors a custom access-token TTL on sign-up", async () => {
    const t = setup();
    const before = Date.now();
    const bundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...ttl({
        accessTokenTtlSeconds: 300, // 5 minutes
      }),
    });
    // The JWT `exp` is floored to the second, so allow a small window.
    const expMs = decodeJwt(bundle.accessToken).exp! * 1000;
    expect(expMs).toBeGreaterThanOrEqual(before + 300_000 - 1000);
    expect(expMs).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  test("honors a custom inactivity timeout on sign-up and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = Date.now();
    const bundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...ttl({
        refreshInactivityTimeoutSeconds: oneHourSeconds,
      }),
    });
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThanOrEqual(
      before + oneHourMs,
    );
    expect(bundle.refreshTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + oneHourMs,
    );

    // The rotated token gets the configured lifetime too.
    const rotated = expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...ttl({
          refreshInactivityTimeoutSeconds: oneHourSeconds,
        }),
      }),
    );
    expect(rotated.refreshTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + oneHourMs,
    );
  });

  test("caps the refresh token's expiry at the session's max lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const lifetimes = ttl({
      refreshInactivityTimeoutSeconds: 2 * 60 * 60,
      sessionMaxLifetimeSeconds: 3 * 60 * 60,
    });
    const bundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...lifetimes,
    });
    const [session] = await t.run(async (ctx) =>
      ctx.db.query("sessions").collect(),
    );
    // Fresh, the inactivity timeout comes first.
    expect(bundle.refreshTokenExpiresAt).toBe(Date.now() + 2 * HOUR_MS);

    // Two hours in, the max lifetime comes first.
    vi.advanceTimersByTime(2 * HOUR_MS - 60_000);
    const rotated = expectRotated(
      await t.mutation(api.public.refresh, {
        refreshToken: bundle.refreshToken,
        ...lifetimes,
      }),
    );
    expect(rotated.refreshTokenExpiresAt).toBe(
      session._creationTime + 3 * HOUR_MS,
    );
  });

  test("rejects a configuration where the access TTL is not shorter than the inactivity timeout", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public._internal_dangerous_signUp, {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        createUserHandle: CREATE_USER_HANDLE,
        ...DEFAULT_TTL,
        accessTokenTtlSeconds: 100,
        refreshInactivityTimeoutSeconds: 1, // 1s — shorter than the 100s access token
      }),
    ).rejects.toThrow(/shorter than the refresh inactivity timeout/i);
  });

  test("rejects a configuration where the inactivity timeout is longer than the max lifetime", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public._internal_dangerous_signUp, {
        claims: claims(),
        componentPath: COMPONENT_PATH,
        createUserHandle: CREATE_USER_HANDLE,
        ...DEFAULT_TTL,
        refreshInactivityTimeoutSeconds: 2 * 60 * 60,
        sessionMaxLifetimeSeconds: 60 * 60,
      }),
    ).rejects.toThrow(/at most the session max lifetime/i);
  });

  test("accepts an inactivity timeout equal to the max lifetime", async () => {
    const t = setup();
    const bundle = await t.mutation(api.public._internal_dangerous_signUp, {
      claims: claims(),
      componentPath: COMPONENT_PATH,
      createUserHandle: CREATE_USER_HANDLE,
      ...ttl({
        refreshInactivityTimeoutSeconds: 60 * 60,
        sessionMaxLifetimeSeconds: 60 * 60,
      }),
    });
    const [session] = await t.run(async (ctx) =>
      ctx.db.query("sessions").collect(),
    );
    expect(bundle.refreshTokenExpiresAt).toBeLessThanOrEqual(
      session._creationTime + HOUR_MS,
    );
  });
});

describe("getSession", () => {
  /** The session id a bundle's access token points at, from its `sub` claim. */
  function sessionIdOf(bundle: TokenBundle): string {
    return decodeJwt(bundle.accessToken).sub!;
  }

  test("returns the user id while the session is live", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const session = await t.query(api.public.getSession, {
      sessionId: sessionIdOf(bundle),
    });
    expect(session).toEqual({ userId: bundle.userId });
  });

  test("keeps answering for the same session across a refresh", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const rotated = expectRotated(await refresh(t, bundle.refreshToken));
    // The refreshed access token names the same session.
    expect(sessionIdOf(rotated)).toBe(sessionIdOf(bundle));
    const session = await t.query(api.public.getSession, {
      sessionId: sessionIdOf(bundle),
    });
    expect(session).toEqual({ userId: bundle.userId });
  });

  test("returns null once the session is revoked", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    await t.mutation(api.public.signOut, {
      refreshToken: bundle.refreshToken,
    });
    const session = await t.query(api.public.getSession, {
      sessionId: sessionIdOf(bundle),
    });
    expect(session).toBeNull();
  });

  test("returns null for a string that is not a session id", async () => {
    const t = setup();
    await signUp(t, claims());
    expect(
      await t.query(api.public.getSession, { sessionId: "not-a-session-id" }),
    ).toBeNull();
  });

  test("returns null for an id in another table", async () => {
    const t = setup();
    await signUp(t, claims());
    const tokenId = await t.run(
      async (ctx) => (await ctx.db.query("refreshTokens").unique())!._id,
    );
    expect(
      await t.query(api.public.getSession, { sessionId: tokenId }),
    ).toBeNull();
  });
});
