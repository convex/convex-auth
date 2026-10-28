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
import {
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
  REFRESH_GRACE_MS,
  SPENT_TOKEN_HORIZON_MS,
} from "./public.ts";

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
const AUDIENCE = "convex";
const CREATE_USER_HANDLE = "testApp:createUser";
const ON_SIGN_IN_HANDLE = "testApp:onSignIn";
const THROWING_ON_SIGN_IN_HANDLE = "testApp:onSignInThatThrows";

/** Verify an access token against the test deployment's JWKS. */
async function verifyAccessToken(t: ConvexTestApi, token: string) {
  const jwks = createLocalJWKSet(await t.jwks());
  return await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
}

function claims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    providerName: "password",
    providerAccountId: "alice",
    profile: { name: "Alice" },
    ...overrides,
  };
}

function setup() {
  return convexTest(schema, modules);
}

type ConvexTestApi = ReturnType<typeof setup>;

/** Establish a brand new identity: its app user and a session. */
async function signUp(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public.signUp, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
  });
}

/**
 * Sign a known user back in, as an app that attached an `onSignIn` does. The
 * provider resolved the identity to `userId` in its own component; the core
 * keeps no accounts of its own.
 */
async function signIn(t: ConvexTestApi, c: AuthClaims, userId: string) {
  return await t.mutation(api.public.signIn, {
    claims: c,
    userId,
    onSignInHandle: ON_SIGN_IN_HANDLE,
  });
}

/** Assert a refresh rotated the token, and narrow to the new bundle. */
function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

/** Exchange a refresh token, as a client rotating its session does. */
async function refresh(t: ConvexTestApi, refreshToken: string) {
  return await t.mutation(api.public.refresh, { refreshToken });
}

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
    // The session records the provider that signed it in, and the user the
    // app minted. The core stores nothing else about the identity.
    expect(session).toMatchObject({
      userId: bundle.userId,
      provider: "password",
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
        provider: {
          name: "password",
          accountId: "alice",
          profile: { name: "Alice" },
        },
      },
    ]);
    // A first sign-in is still a sign-in, so onSignIn runs too, with the id
    // createUser just returned. Per-sign-in work has one home.
    expect(testApp.getOnSignInCalls()).toEqual([
      {
        provider: {
          name: "password",
          accountId: "alice",
          profile: { name: "Alice" },
        },
        userId: bundle.userId,
      },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The bundle carries the id the app's createUser returned, which is what
    // the provider records against its identity.
    expect(bundle.userId).toBe("user1");
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
  });

  test("an onSignIn that throws rolls back the user it just created", async () => {
    const t = setup();

    await expect(
      t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        onSignInHandle: THROWING_ON_SIGN_IN_HANDLE,
      }),
    ).rejects.toThrow(/no sign-ins for you/);

    // The app's own users row is a write of the same mutation, so it rolls
    // back with it (the fixture's createUser keeps no rows, so the caller
    // count stands in). The session was never reached, since onSignIn runs
    // before it is minted.
    expect(await sessionCount(t)).toBe(0);
  });

  test("mints a user on every call: telling a new identity from a known one is the provider's job", async () => {
    const t = setup();
    const first = await signUp(t, claims());
    const second = await signUp(t, claims());

    // The core keeps no accounts, so it cannot refuse a repeated sign-up of
    // one identity. The provider's component is where that check lives,
    // which is why providers resolve the identity there before choosing
    // between signUp and signIn.
    expect(second.userId).not.toBe(first.userId);
    expect(await sessionCount(t)).toBe(2);
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
    // A fresh session per sign-in, both for the one user and through the
    // same provider.
    const sessions = await t.run(
      async (ctx) => await ctx.db.query("sessions").collect(),
    );
    expect(sessions).toHaveLength(2);
    expect(
      sessions.map(({ userId, provider }) => ({ userId, provider })),
    ).toEqual([
      { userId: first.userId, provider: "password" },
      { userId: first.userId, provider: "password" },
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
      provider: {
        name: "password",
        accountId: "alice",
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
    const bundle = await t.mutation(api.public.signIn, {
      claims: claims(),
      userId: first.userId,
    });

    expect(bundle.userId).toBe(first.userId);
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
  });

  test("takes the provider's word for the user: no app user has to exist", async () => {
    const t = setup();

    // The core cannot check the user id against the app's users table, nor
    // against accounts of its own. A provider that passes a wrong id signs
    // the caller in as that user, which is why providers only pass an id
    // read from their own component after verifying the identity.
    const bundle = await signIn(t, claims(), "someone");
    expect(bundle.userId).toBe("someone");
    expect(await sessionCount(t)).toBe(1);
  });

  test("refuses an empty user id", async () => {
    const t = setup();

    // The placeholder a provider without an identifier of its own sends as
    // the account id must never reach here as the user id.
    await expect(signIn(t, claims(), "")).rejects.toThrow(/no user id/i);
    expect(await sessionCount(t)).toBe(0);
  });
});

describe("createUser", () => {
  test("creates the user, but no session", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const { userId } = await t.mutation(api.public.createUser, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The id is the one the app's createUser returned.
    expect(userId).toBe("user1");
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    // No sign-in happened, so onSignIn does not run, and no session was
    // minted.
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
    expect(await sessionCount(t)).toBe(0);
  });

  test("a later signIn with the user id mints a session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.createUser, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    const bundle = await signIn(t, claims(), userId);
    expect(bundle.userId).toBe(userId);
    expect(await sessionCount(t)).toBe(1);
  });
});

describe("refresh", () => {
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
    const t = setup();
    const bundle = await signUp(t, claims());

    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    // Force the redeemed token past its expiry.
    await t.run(async (ctx) => {
      const [redeemed] = (await ctx.db.query("refreshTokens").collect()).filter(
        (r) => r.state === "redeemed",
      );
      await ctx.db.patch(redeemed._id, { expiresAt: Date.now() - 1000 });
    });

    const result = await refresh(t, bundle.refreshToken);
    expect(result.kind).toBe("noSession");

    // The dead session was removed in the same transaction, tokens and all.
    expect(await sessionCount(t)).toBe(0);
    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
  });

  test("reports no session for an expired issued token", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const successor = expectRotated(await refresh(t, bundle.refreshToken));

    await t.run(async (ctx) => {
      const [issued] = (await ctx.db.query("refreshTokens").collect()).filter(
        (r) => r.state === "issued",
      );
      await ctx.db.patch(issued._id, { expiresAt: Date.now() - 1000 });
    });

    expect((await refresh(t, successor.refreshToken)).kind).toBe("noSession");
    expect(await sessionCount(t)).toBe(0);
    expect(await issuedHashes(t)).toEqual([]);
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

    // A refresh token must never outlive the session it names.
    expect(await retiredHashes(t)).toEqual([]);
    expect(await issuedHashes(t)).toEqual([]);
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
    await signUp(t, claims({ providerAccountId: "bob" }));

    const sessions = await t.query(api.public.listSessions, {
      userId: aliceBundle.userId,
    });
    expect(sessions.map((s) => s.sessionId)).toEqual([
      sessionIdOf(aliceBundle),
    ]);
  });

  test("reports when the session's newest refresh token was issued and when it expires", async () => {
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
        expiresAt: rotated.refreshTokenExpiresAt,
      },
    ]);
    expect(rotated.refreshTokenExpiresAt).toBeGreaterThan(
      bundle.refreshTokenExpiresAt,
    );
  });

  test("includes a session whose refresh tokens have all expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t = setup();
    const bundle = await signUp(t, claims());
    const shortLived = await t.mutation(api.public.signIn, {
      claims: claims(),
      userId: bundle.userId,
      refreshTokenTtlSeconds: 60 * 60,
    });
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    const sessions = await t.query(api.public.listSessions, {
      userId: bundle.userId,
    });
    const expired = sessions.find(
      (s) => s.sessionId === sessionIdOf(shortLived),
    );
    expect(expired?.expiresAt).toBe(shortLived.refreshTokenExpiresAt);
    expect(expired!.expiresAt!).toBeLessThan(Date.now());
    expect(sessions).toHaveLength(2);
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
    const bob = await signUp(t, claims({ providerAccountId: "bob" }));

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
    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      accessTokenTtlSeconds: 300, // 5 minutes
    });
    // The JWT `exp` is floored to the second, so allow a small window.
    const expMs = decodeJwt(bundle.accessToken).exp! * 1000;
    expect(expMs).toBeGreaterThanOrEqual(before + 300_000 - 1000);
    expect(expMs).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  test("honors a custom refresh-token TTL on sign-up and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = Date.now();
    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      refreshTokenTtlSeconds: oneHourSeconds,
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
        refreshTokenTtlSeconds: oneHourSeconds,
      }),
    );
    expect(rotated.refreshTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + oneHourMs,
    );
  });

  test("rejects a configuration where the access TTL is not shorter than the refresh TTL", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.signUp, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 1, // 1s — shorter than the 100s access token
      }),
    ).rejects.toThrow(/shorter than the refresh-token TTL/i);
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
