import { convexTest } from "convex-test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { api, internal } from "./_generated/api.ts";
import { createFunctionHandle, makeFunctionReference } from "convex/server";
import type { Doc } from "./_generated/dataModel.ts";
import schema from "./schema.ts";
import * as testApp from "./testApp.fixture.ts";
import {
  type AuthClaims,
  type TokenBundle,
  type RefreshResult,
  USE_USER_ID_AS_ACCOUNT_ID,
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

// The core reads its signing material from `AUTH_PRIVATE_KEY` / `AUTH_JWKS`
// (env vars in production). We mint a real RS256 key pair once and set those
// vars so the suite exercises genuine JWT signing/verification.
const ISSUER = "https://example.convex.site";
const AUDIENCE = "convex";
const CREATE_USER_HANDLE = "testApp:createUser";
const ON_SIGN_IN_HANDLE = "testApp:onSignIn";
const THROWING_ON_SIGN_IN_HANDLE = "testApp:onSignInThatThrows";
let publicJwk: JWK;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  publicJwk = await exportJWK(publicKey);
  const kid = "test-key";
  process.env.AUTH_PRIVATE_KEY = btoa(pkcs8);
  process.env.AUTH_JWKS = JSON.stringify({
    keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
  });
});

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

async function configure(
  t: ConvexTestApi,
  options: {
    onSignIn?: boolean;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
  } = {},
) {
  const provider = await t.run(async () => ({
    name: "password",
    createUser: await createFunctionHandle(
      makeFunctionReference<"mutation">(CREATE_USER_HANDLE),
    ),
    onSignIn:
      options.onSignIn === false
        ? undefined
        : await createFunctionHandle(
            makeFunctionReference<"mutation">(ON_SIGN_IN_HANDLE),
          ),
  }));
  await t.mutation(internal.init.configure, {
    providers: [provider],
    accessTokenTtlSeconds: options.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: options.refreshTokenTtlSeconds,
  });
}

/** Establish a brand new identity: the account, its app user, and a session. */
async function signUp(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public.signUp, {
    claims: c,
    createUserHandle: CREATE_USER_HANDLE,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    issuer: ISSUER,
  });
}

/** Sign a known identity back in, as an app that attached an `onSignIn` does. */
async function signIn(t: ConvexTestApi, c: AuthClaims) {
  return await t.mutation(api.public.signIn, {
    claims: c,
    onSignInHandle: ON_SIGN_IN_HANDLE,
    issuer: ISSUER,
  });
}

/** Assert a refresh rotated the token, and narrow to the new bundle. */
function expectRotated(result: RefreshResult): TokenBundle {
  expect(result.kind).toBe("rotated");
  return (result as Extract<RefreshResult, { kind: "rotated" }>).tokens;
}

/** Exchange a refresh token, as a client rotating its session does. */
async function refresh(t: ConvexTestApi, refreshToken: string) {
  return await t.mutation(api.public.refresh, { refreshToken, issuer: ISSUER });
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
  test("creates an account + session and mints a verifiable JWT", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());

    // The app's createUser echoes the providerAccountId as the user id.
    expect(bundle.userId).toBe("alice");
    expect(bundle.refreshToken).toBeTruthy();
    expect(bundle.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(bundle.refreshTokenExpiresAt).toBeGreaterThan(
      bundle.accessTokenExpiresAt,
    );

    // The access token verifies against the served JWKS with the right claims.
    const key = await importJWK(publicJwk, "RS256");
    const { payload } = await jwtVerify(bundle.accessToken, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(payload.sub).toBe("alice");

    // Exactly one account and one session exist.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });

  test("invokes the app's createUser with the claims, then onSignIn", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    await signUp(t, claims({ profile: { name: "Alice" } }));

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
        userId: "alice",
      },
    ]);
  });

  test("creates the user without an onSignIn attached", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      issuer: ISSUER,
    });

    expect(bundle.userId).toBe("alice");
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
        issuer: ISSUER,
      }),
    ).rejects.toThrow(/no sign-ins for you/);

    // The account insert is a write of the same mutation, so it rolls back with
    // it, and the app's own users row rolls back the same way. The session was
    // never reached, since onSignIn runs before it is minted.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 0, sessions: 0 });
  });

  test("refuses to sign up an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());

    // Rather than minting a second app user for someone who already has one.
    await expect(signUp(t, claims())).rejects.toThrow(/already\s+exists/i);

    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });
});

describe("signIn", () => {
  test("reuses the existing account and mints a fresh session", async () => {
    const t = setup();
    const first = await signUp(t, claims({ profile: { name: "Alice" } }));
    const second = await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

    expect(second.userId).toBe(first.userId);

    const { accounts, sessions } = await t.run(async (ctx) => {
      const accountDocs = await ctx.db.query("accounts").collect();
      const sessionDocs = await ctx.db.query("sessions").collect();
      return {
        accounts: accountDocs.length,
        sessions: sessionDocs.length,
      };
    });
    // One account reused; a fresh session per sign-in.
    expect(accounts).toBe(1);
    expect(sessions).toBe(2);
  });

  test("invokes the app's onSignIn with the resolved user id and latest claims", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    await signUp(t, claims({ profile: { name: "Alice" } }));
    await signIn(t, claims({ profile: { name: "Alice 2.0" } }));

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
      userId: "alice",
    });
  });

  test("mints the session without notifying an app that attached no onSignIn", async () => {
    const t = setup();
    await signUp(t, claims());
    testApp.resetUserCallbackCalls();

    // No `onSignInHandle` is what an app that left `onSignIn` out sends.
    const bundle = await t.mutation(api.public.signIn, {
      claims: claims(),
      issuer: ISSUER,
    });

    expect(bundle.userId).toBe("alice");
    expect(testApp.getOnSignInCalls()).toHaveLength(0);
  });

  test("refuses to sign in an identity with no account", async () => {
    const t = setup();

    // A miss means the provider's records and the core's have diverged, and
    // creating a user here would paper over that.
    await expect(signIn(t, claims())).rejects.toThrow(
      /must go through signUp/i,
    );

    const sessions = await t.run(
      async (ctx) => (await ctx.db.query("sessions").collect()).length,
    );
    expect(sessions).toBe(0);
  });
});

describe("signUpWithoutSession", () => {
  test("creates the user and the account, but no session", async () => {
    const t = setup();
    testApp.resetUserCallbackCalls();

    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The app's createUser echoes the providerAccountId as the user id.
    expect(userId).toBe("alice");
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    // No sign-in happened, so onSignIn does not run.
    expect(testApp.getOnSignInCalls()).toHaveLength(0);

    // The account exists, but no session was minted.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 0 });
  });

  test("a later signIn resolves the same user and mints a session", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
    });

    const bundle = await signIn(t, claims());
    expect(bundle.userId).toBe(userId);

    // The sign-in reused the account that signUpWithoutSession made.
    const counts = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
    }));
    expect(counts).toEqual({ accounts: 1, sessions: 1 });
  });

  test("keys the account by the minted user id with USE_USER_ID_AS_ACCOUNT_ID", async () => {
    const t = setup();
    const { userId } = await t.mutation(api.public.signUpWithoutSession, {
      claims: claims({
        providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
        profile: { email: "alice@example.com" },
      }),
      createUserHandle: CREATE_USER_HANDLE,
    });

    // The account's identifier is the user id the app minted, so a later
    // sign-in that passes the user id resolves the same user.
    const bundle = await signIn(t, claims({ providerAccountId: userId }));
    expect(bundle.userId).toBe(userId);

    const accounts = await t.run(
      async (ctx) => await ctx.db.query("accounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerAccountId).toBe(userId);
  });

  test("refuses an identity that already has an account", async () => {
    const t = setup();
    await signUp(t, claims());

    // Like signUp: a second app user for the same identity is never minted.
    await expect(
      t.mutation(api.public.signUpWithoutSession, {
        claims: claims(),
        createUserHandle: CREATE_USER_HANDLE,
      }),
    ).rejects.toThrow(/already\s+exists/i);

    const accounts = await t.run(
      async (ctx) => (await ctx.db.query("accounts").collect()).length,
    );
    expect(accounts).toBe(1);
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

describe("token lifetime configuration", () => {
  test("honors a custom access-token TTL on sign-up", async () => {
    const t = setup();
    const before = Date.now();
    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      issuer: ISSUER,
      accessTokenTtlSeconds: 300, // 5 minutes
    });
    // The JWT `exp` is floored to the second, so allow a small window.
    expect(bundle.accessTokenExpiresAt).toBeGreaterThanOrEqual(
      before + 300_000 - 1000,
    );
    expect(bundle.accessTokenExpiresAt).toBeLessThanOrEqual(
      Date.now() + 300_000,
    );
  });

  test("honors a custom refresh-token TTL on sign-up and on rotation", async () => {
    const t = setup();
    const oneHourSeconds = 60 * 60;
    const oneHourMs = oneHourSeconds * 1000;

    const before = Date.now();
    const bundle = await t.mutation(api.public.signUp, {
      claims: claims(),
      createUserHandle: CREATE_USER_HANDLE,
      issuer: ISSUER,
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
        issuer: ISSUER,
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
        issuer: ISSUER,
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 1, // 1s — shorter than the 100s access token
      }),
    ).rejects.toThrow(/shorter than the refresh-token TTL/i);
  });
});

describe("getUserIdByAccount", () => {
  test("returns null for an unknown identity", async () => {
    const t = setup();
    const userId = await t.query(api.public.getUserIdByAccount, {
      provider: "password",
      providerAccountId: "alice",
    });
    expect(userId).toBeNull();
  });

  test("returns the user id after the account is created by signUp", async () => {
    const t = setup();
    const bundle = await signUp(t, claims());
    const userId = await t.query(api.public.getUserIdByAccount, {
      provider: "password",
      providerAccountId: "alice",
    });
    expect(userId).toBe(bundle.userId);
  });

  test("does not confuse identities across providers", async () => {
    const t = setup();
    await signUp(
      t,
      claims({ providerName: "password", providerAccountId: "alice" }),
    );
    const other = await t.query(api.public.getUserIdByAccount, {
      provider: "google",
      providerAccountId: "alice",
    });
    expect(other).toBeNull();
  });
});

describe("component configuration", () => {
  beforeEach(() => {
    testApp.resetUserCallbackCalls();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  test("a rejecting configured hook rolls back account and session creation", async () => {
    const t = setup();
    await configure(t);
    const config = await t.run((ctx) => ctx.db.query("configuration").unique());
    const onSignIn = await t.run(() =>
      createFunctionHandle(
        makeFunctionReference<"mutation">(THROWING_ON_SIGN_IN_HANDLE),
      ),
    );
    await t.mutation(internal.init.configure, {
      providers: [{ ...config!.providers![0], onSignIn }],
    });
    await expect(
      t.mutation(api.public.signUp, { claims: claims(), issuer: ISSUER }),
    ).rejects.toThrow("no sign-ins for you");
    expect(await sessionCount(t)).toBe(0);
    expect(
      await t.run((ctx) => ctx.db.query("accounts").collect()),
    ).toHaveLength(0);
  });
  test("sign-up and sign-in invoke configured callbacks without per-call handles", async () => {
    const t = setup();
    await configure(t);
    const args = { claims: claims(), issuer: ISSUER };
    await t.mutation(api.public.signUp, args);
    await t.mutation(api.public.signIn, args);
    expect(testApp.getCreateUserCalls()).toHaveLength(1);
    expect(testApp.getOnSignInCalls()).toHaveLength(2);
  });

  test("replacing settings removes omitted hooks and TTL overrides", async () => {
    const t = setup();
    await configure(t, {
      accessTokenTtlSeconds: 120,
      refreshTokenTtlSeconds: 3600,
    });
    await t.mutation(api.public.signUp, { claims: claims(), issuer: ISSUER });
    await configure(t, { onSignIn: false });
    await t.mutation(api.public.signIn, { claims: claims(), issuer: ISSUER });
    expect(testApp.getOnSignInCalls()).toHaveLength(1);
    const config = await t.run((ctx) => ctx.db.query("configuration").unique());
    expect(config?.providers?.[0].onSignIn).toBeUndefined();
    expect(config?.accessTokenTtlSeconds).toBeUndefined();
    expect(config?.refreshTokenTtlSeconds).toBeUndefined();
  });

  test("configuration preserves accounts and sessions created before init", async () => {
    const t = setup();
    const original = await signUp(t, claims());
    await configure(t, {
      accessTokenTtlSeconds: 120,
      refreshTokenTtlSeconds: 3600,
    });
    await configure(t, {
      accessTokenTtlSeconds: 120,
      refreshTokenTtlSeconds: 3600,
    });
    const rotated = expectRotated(await refresh(t, original.refreshToken));
    expect(rotated.userId).toBe(original.userId);
    expect(rotated.accessTokenExpiresAt - Date.now()).toBe(120_000);
    expect(rotated.refreshTokenExpiresAt - Date.now()).toBe(3_600_000);
    expect(await sessionCount(t)).toBe(1);
    expect(
      await t.run((ctx) => ctx.db.query("accounts").collect()),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("configuration").collect()),
    ).toHaveLength(1);
  });

  test("unregistered providers fail before creating users", async () => {
    const t = setup();
    await configure(t);
    await expect(
      t.mutation(api.public.signUp, {
        claims: claims({ providerName: "missing" }),
        issuer: ISSUER,
      }),
    ).rejects.toThrow('Auth provider "missing" is not configured');
    expect(testApp.getCreateUserCalls()).toHaveLength(0);
    expect(await sessionCount(t)).toBe(0);
  });

  test("duplicate providers and invalid lifetimes leave existing settings intact", async () => {
    const t = setup();
    await configure(t);
    const before = await t.run((ctx) => ctx.db.query("configuration").unique());
    const provider = before!.providers![0];
    await expect(
      t.mutation(internal.init.configure, {
        providers: [provider, provider],
      }),
    ).rejects.toThrow("already configured");
    await expect(
      t.mutation(internal.init.configure, {
        providers: [],
        accessTokenTtlSeconds: 100,
        refreshTokenTtlSeconds: 1,
      }),
    ).rejects.toThrow("shorter than");
    expect(
      await t.run((ctx) => ctx.db.query("configuration").unique()),
    ).toEqual(before);
  });
});
