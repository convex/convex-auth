import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server.ts";
import { Doc, Id } from "./_generated/dataModel.ts";
import { GenericId, v } from "convex/values";
import {
  FunctionArgs,
  FunctionHandle,
  FunctionReturnType,
} from "convex/server";
import {
  vAuthClaims,
  type AuthClaims,
  vTokenBundle,
  type TokenBundle,
  vRefreshResult,
  type RefreshResult,
  USE_USER_ID_AS_ACCOUNT_ID,
  type CreateUserFn,
  type OnSignInFn,
} from "../lib/types.ts";
import { generateRefreshToken } from "./crypto.ts";
import { sha256Hex } from "../lib/crypto.ts";

// --- Configuration ---------------------------------------------------------

// `aud` claim; must match `applicationID` in the app's auth.config.ts.
const AUDIENCE = "convex";
// Defaults for the configurable token lifetimes. The app overrides them per
// deployment via `setupConvexAuth`, which threads the chosen values in as call args;
// when it passes nothing, these apply.
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// `ctx.auth.signJwt` refuses to mint a token that lives longer than an hour,
// so an access-token TTL past that is a misconfiguration.
const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
// How many issued, never-presented refresh tokens a session may have. Each
// refresh presenting the redeemed token adds one, and the first issued token
// presented clears them all, so the count only climbs when responses are lost
// or refreshes race. A refresh with this many already issued revokes the
// session, unless the redeemed token was redeemed within `REFRESH_GRACE_MS`.
export const STANDARD_ISSUED_REFRESH_TOKEN_LIMIT = 3;
// How long after a token is redeemed it may be presented again without
// counting against `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT`. Concurrent SSR
// requests carrying the same cookie each refresh on their own, and the first to
// land redeems the token the rest present.
export const REFRESH_GRACE_MS = 5 * 1000; // 5 seconds
// How long a spent or dropped refresh token hash is remembered. This is the
// reuse-detection horizon: past it the row is gone and a replayed token reads
// as unknown, which revokes nothing but also grants nothing.
export const SPENT_TOKEN_HORIZON_MS = 60 * 60 * 1000; // 1 hour

// The `iss` claim is set by the deployment when this component calls
// `ctx.auth.signJwt`: `${CONVEX_CLOUD_URL}/components/auth`, which is what the
// app's auth.config.ts must name as the issuer.

// --- Internal helpers ------------------------------------------------------

/** Look up an account by its provider identity. */
function accountByIdentity(
  ctx: QueryCtx,
  provider: string,
  providerAccountId: string,
): Promise<Doc<"accounts"> | null> {
  return ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .unique();
}

/** Look up a refresh token, in any state, by its hash. */
function lookupRefreshTokenByHash(
  ctx: QueryCtx,
  hash: string,
): Promise<Doc<"refreshTokens"> | null> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
}

/** A session's refresh tokens in one state. */
function sessionTokensInState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  state: Doc<"refreshTokens">["state"],
): Promise<Doc<"refreshTokens">[]> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) =>
      q.eq("sessionId", sessionId).eq("state", state),
    )
    .collect();
}

/**
 * Erase a session along with every refresh token that points at it.
 *
 * Idempotent, because callers can race: two replays of the same stolen token,
 * or a sign-out arriving alongside one, can both resolve the same session.
 */
async function deleteSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  // Reads every token row the session has. That is fine at any plausible
  // refresh rate — the horizon divided by the refresh interval, ~60 at the
  // defaults — but it is unbounded in principle. A session refreshed
  // pathologically often could exceed the transaction's limits and make the
  // session unusable.
  const tokens = await ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of tokens) {
    await ctx.db.delete("refreshTokens", row._id);
  }
  // `delete` throws on an id that is already gone, and the session may have
  // been deleted by whoever we raced.
  if ((await ctx.db.get("sessions", sessionId)) !== null) {
    await ctx.db.delete("sessions", sessionId);
  }
}

/**
 * Erase this session's spent and dropped tokens that are past the detection
 * horizon.
 *
 * Spent and dropped tokens are kept to detect illegitimate use of a refresh
 * token. Only a bounded set is kept for that purpose though, thus this code to
 * prune rows retired longer than `SPENT_TOKEN_HORIZON_MS` ago.
 *
 * Cleanup is triggered by redeeming an issued token, so a steadily refreshing
 * session keeps its own set trimmed with no background job to run or mount.
 */
async function pruneRetiredTokens(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<void> {
  // A session that stops refreshing keeps its remaining rows until it is
  // deleted, since nothing rotates it any more. Sweeping those orphans is what a
  // background job would add; see KNOWN_ISSUES.md.
  for (const state of ["spent", "dropped"] as const) {
    const expired = await ctx.db
      .query("refreshTokens")
      .withIndex("by_session_state", (q) =>
        q
          .eq("sessionId", sessionId)
          .eq("state", state)
          .lte("retiredAt", now - SPENT_TOKEN_HORIZON_MS),
      )
      .collect();
    for (const row of expired) {
      await ctx.db.delete("refreshTokens", row._id);
    }
  }
}

/**
 * Issue a new refresh token for a session, valid until `ttl` from now.
 *
 * Returns the raw token, and stores its hash for later lookup.
 */
async function issueRefreshToken(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
  ttl: TtlConfig,
): Promise<{ refreshToken: string; expiresAt: number }> {
  const refreshToken = generateRefreshToken();
  const expiresAt = now + ttl.refreshTokenTtlSeconds * 1000;
  await ctx.db.insert("refreshTokens", {
    hash: await sha256Hex(refreshToken),
    sessionId,
    state: "issued",
    expiresAt,
  });
  return { refreshToken, expiresAt };
}

/**
 * The token lifetimes for a call, with the app's overrides applied over the
 * defaults. Validated so a misconfiguration fails loudly rather than minting
 * nonsensical sessions.
 */
type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}): TtlConfig {
  const accessTokenTtlSeconds =
    args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTokenTtlSeconds =
    args.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  if (accessTokenTtlSeconds <= 0 || refreshTokenTtlSeconds <= 0) {
    throw new Error("Token TTLs must be positive.");
  }
  if (accessTokenTtlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error(
      "Access-token TTL must be at most one hour (the deployment refuses " +
        "to sign a longer-lived JWT).",
    );
  }
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh-token TTL.",
    );
  }
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}

/**
 * Mint the access token with the deployment's signing key. The deployment
 * populates `iss` (`${CONVEX_CLOUD_URL}/components/auth`), `iat` and `exp`;
 * this sets the claims the core owns: the subject and the audience.
 *
 * The subject is the session id, not the user id: the app resolves the user
 * through the session (see `getSession`), so a revoked session stops
 * resolving to a user before its tokens expire.
 */
async function mintAccessToken(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  ttlSeconds: number,
): Promise<string> {
  return await ctx.auth.signJwt({
    claims: { sub: sessionId, aud: AUDIENCE },
    expiresInSeconds: ttlSeconds,
  });
}

async function issueSession(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  userId: string,
  ttl: TtlConfig,
): Promise<TokenBundle> {
  const now = Date.now();
  // TODO: cap the sessions a user may have (e.g. 100), deleting the oldest
  // when a new one would exceed it. That bounds `listSessions`, which reads
  // every session of the user, for a user whose sessions pile up (e.g. a
  // script signing in over and over).
  const sessionId = await ctx.db.insert("sessions", {
    userId,
    accountId,
  });
  // Issued like any other token: it is redeemed on the session's first
  // refresh.
  const { refreshToken, expiresAt } = await issueRefreshToken(
    ctx,
    sessionId,
    now,
    ttl,
  );
  const accessToken = await mintAccessToken(
    ctx,
    sessionId,
    ttl.accessTokenTtlSeconds,
  );
  return {
    accessToken,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
    userId,
  };
}

// The callback types carry their args and return type in the `_fn` slot and
// have no `_args`/`_returnType` of their own, so read both back through
// `FunctionArgs`/`FunctionReturnType` rather than by indexing.
type CreateUserFunctionHandle = FunctionHandle<
  CreateUserFn<string, unknown>["_type"],
  FunctionArgs<CreateUserFn<string, unknown>>,
  FunctionReturnType<CreateUserFn<string, unknown>>
>;

type OnSignInFunctionHandle = FunctionHandle<
  OnSignInFn<string, unknown>["_type"],
  FunctionArgs<OnSignInFn<string, unknown>>,
  FunctionReturnType<OnSignInFn<string, unknown>>
>;

/**
 * Type the given userId string as a {@link GenericId}.
 *
 * The core stores app user ids as opaque strings and has no access to the
 * app's data model. The type for user-supplied callbacks types them as
 * `Id<usersTable>` for the app's benefit, so re-brand on the way back out. The
 * value is the same string either way.
 */
function asUserId(userId: string): GenericId<string> {
  return userId as GenericId<string>;
}

/**
 * Create the account and app-level user for an identity the core has not seen before.
 *
 * The app's `createUser` callback mints and returns the user id, and this
 * records the provider-identity -> user mapping. Returns what minting a
 * session needs: the account id and its app user id. The claims are passed to
 * the `createUser` callback.
 *
 * Both `signUp` and the sessionless `signUpWithoutSession` build on this.
 */
async function createAccount(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUser: CreateUserFunctionHandle,
): Promise<{ accountId: Id<"accounts">; userId: string }> {
  // `USE_USER_ID_AS_ACCOUNT_ID` means the account is keyed by the app user id,
  // which does not exist until the callback below mints it. Such claims can
  // never match an existing account (accounts are never stored with an empty
  // identifier), so there is nothing to check yet; the pre-insert check below
  // covers that path once the key is known.
  if (claims.providerAccountId !== USE_USER_ID_AS_ACCOUNT_ID) {
    const account = await accountByIdentity(
      ctx,
      claims.providerName,
      claims.providerAccountId,
    );
    if (account !== null) {
      // Creating an account for an identity that already has one would mint a
      // second app user for someone who already has one. Fail before calling
      // the app.
      throw new Error(
        `Cannot create an account: an account for provider = ${JSON.stringify(claims.providerName)} ` +
          `and provider account ID = ${JSON.stringify(claims.providerAccountId)} already ` +
          `exists. Providers that cannot tell a first sign-in from a return visit must ` +
          `look the identity up (getUserIdByAccount) and call signIn instead.`,
      );
    }
  }

  const userId = await ctx.runMutation(createUser, {
    provider: {
      name: claims.providerName,
      accountId: claims.providerAccountId,
      profile: claims.profile,
    },
  });
  const { providerName } = claims;
  const providerAccountId =
    claims.providerAccountId === USE_USER_ID_AS_ACCOUNT_ID
      ? userId
      : claims.providerAccountId;
  // The last word on uniqueness, for the `USE_USER_ID_AS_ACCOUNT_ID` path,
  // whose key is only known now. Redundant for every other path, and cheap.
  const existingAccount = await ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) =>
      q.eq("provider", providerName).eq("providerAccountId", providerAccountId),
    )
    .first();
  if (existingAccount !== null) {
    throw new Error(
      `Invariant violation: an account for provider = ${JSON.stringify(providerName)} and provider account ID = ${JSON.stringify(providerAccountId)} already exists`,
    );
  }
  const accountId = await ctx.db.insert("accounts", {
    provider: providerName,
    providerAccountId,
    userId,
  });
  return { accountId, userId };
}

/**
 * Run the app's sign-in callback, if it attached one. Every sign-in goes
 * through here, a first one included, so per-sign-in work in the app has a
 * single home.
 */
async function notifySignIn(
  ctx: MutationCtx,
  claims: AuthClaims,
  userId: string,
  onSignInHandle: string | undefined,
): Promise<void> {
  if (onSignInHandle === undefined) return;
  await ctx.runMutation(onSignInHandle as OnSignInFunctionHandle, {
    provider: {
      name: claims.providerName,
      accountId: claims.providerAccountId,
      profile: claims.profile,
    },
    userId: asUserId(userId),
  });
}

// --- Component API ------------------------------------------------------------

/**
 * Performs an app-integrated new user sign-up.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Providers don't typically call this API directly, but instead use the
 * framework's `completeSignUp` helper. That function takes care of passing the
 * `createUserHandle` and `onSignInHandle` app callbacks.
 *
 * `createUser` mints the app user, then `onSignIn` runs like it does for any
 * other sign-in. An `onSignIn` that throws therefore rolls back the user
 * `createUser` just made, since both are subtransactions of this one.
 *
 * The JWT accessToken in the return value is signed by the deployment, with
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`. Token lifetimes default to
 * 1m (access) and 30d (refresh) unless
 * `accessTokenTtlSeconds` / `refreshTokenTtlSeconds` are supplied (the app
 * sets these once via `setupConvexAuth`).
 *
 * Throws when the identity already has an account. See {@link signIn} for the
 * return-visit path.
 */
export const signUp = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
    onSignInHandle: v.optional(v.string()),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = resolveTtlConfig(args);
    const { accountId, userId } = await createAccount(
      ctx,
      args.claims,
      args.createUserHandle as CreateUserFunctionHandle,
    );
    await notifySignIn(ctx, args.claims, userId, args.onSignInHandle);
    return await issueSession(ctx, accountId, userId, ttl);
  },
});

/**
 * Performs an app-integrated user sign-in.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Providers don't typically call this API directly, but instead use the
 * framework's `completeSignIn` helper. That function takes care of passing the
 * `onSignInHandle` app callback.
 *
 * The JWT accessToken in the return value is signed by the deployment, with
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`. Token lifetimes default to
 * 1m (access) and 30d (refresh) unless
 * `accessTokenTtlSeconds` / `refreshTokenTtlSeconds` are supplied (the app
 * sets these once via `setupConvexAuth`).
 *
 * Throws when the identity has no account.
 */
export const signIn = mutation({
  args: {
    claims: vAuthClaims,
    onSignInHandle: v.optional(v.string()),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = resolveTtlConfig(args);
    const { claims } = args;
    const account = await accountByIdentity(
      ctx,
      claims.providerName,
      claims.providerAccountId,
    );
    if (account === null) {
      throw new Error(
        `Cannot sign in: no account for provider = ${JSON.stringify(claims.providerName)} ` +
          `and provider account ID = ${JSON.stringify(claims.providerAccountId)} exists. ` +
          `A first sign-in for an identity must go through signUp.`,
      );
    }
    await notifySignIn(ctx, claims, account.userId, args.onSignInHandle);
    return await issueSession(ctx, account._id, account.userId, ttl);
  },
});

/**
 * Create the account and the app user for a provider's verified identity
 * claims, without minting a session.
 *
 * Providers use this (via the `signUpWithoutSession` helper the core hands
 * them) when the user must complete a step before the first sign-in — for
 * example, an email validation. Account creation follows the same rules as
 * `signUp` (the app's `createUser` mutation mints the user,
 * `USE_USER_ID_AS_ACCOUNT_ID` keys the account by the minted user id, and an
 * identity that already has an account is refused), but no session is minted
 * and `onSignIn` does not run: the user cannot make authenticated calls until
 * a later `signIn` succeeds.
 */
export const signUpWithoutSession = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
  },
  returns: v.object({ userId: v.string() }),
  handler: async (ctx, args): Promise<{ userId: string }> => {
    // TODO: This API is kind of awkward. We might want to reconsider it before the GA v2 release.
    const { userId } = await createAccount(
      ctx,
      args.claims,
      args.createUserHandle as CreateUserFunctionHandle,
    );
    return { userId };
  },
});

/**
 * Resolve a provider identity to its app user id without minting a session.
 *
 * Providers use this (via the `resolveUserId` helper the core hands them) to look
 * up the user behind a `(provider, providerAccountId)` pair before authenticating
 * — e.g. a password provider needs the user id to verify a stored password *before*
 * a session is issued. Returns `null` when no account exists for the identity.
 *
 * This is a component function; it is callable by the app, not by end-user
 * clients, so it does not expose account existence to the outside world. The
 * provider's own public API decides what, if anything, to reveal.
 */
export const getUserIdByAccount = query({
  args: { provider: v.string(), providerAccountId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (
    ctx,
    { provider, providerAccountId },
  ): Promise<string | null> => {
    const account = await accountByIdentity(ctx, provider, providerAccountId);
    return account?.userId ?? null;
  },
});

/**
 * Look up a live session by its id.
 *
 * Returns an object with the session's `userId` when the session row exists.
 * If there is no row for the session id, it returns `null`.
 *
 * A session is live exactly as long as its row exists: sign-out, refresh-token
 * reuse detection, and expired-token cleanup all delete the row.
 *
 * This is a component function; it is callable by the app, not by end-user
 * clients, so it does not expose session existence to the outside world.
 */
export const getSession = query({
  args: { sessionId: v.string() },
  returns: v.union(v.object({ userId: v.string() }), v.null()),
  handler: async (ctx, { sessionId }): Promise<{ userId: string } | null> => {
    const id = ctx.db.normalizeId("sessions", sessionId);
    if (id === null) return null;
    const session = await ctx.db.get("sessions", id);
    return session === null ? null : { userId: session.userId };
  },
});

/**
 * Redeem an issued token, the first time it is presented.
 *
 * Its holder has evidently received it, so the session's previously redeemed
 * token is marked as spent and the other issued tokens, which nobody should
 * ever present, are marked as dropped.
 */
async function redeem(
  ctx: MutationCtx,
  token: Doc<"refreshTokens">,
  now: number,
): Promise<void> {
  const redeemed = await sessionTokensInState(ctx, token.sessionId, "redeemed");
  if (redeemed.length > 1) {
    throw new Error(
      "Invariant violation: a session has more than one redeemed refresh token",
    );
  }
  // There will be 0 or 1 tokens in the `redeemed`` state.
  for (const row of redeemed) {
    await ctx.db.patch("refreshTokens", row._id, {
      state: "spent",
      retiredAt: now,
    });
  }
  for (const row of await sessionTokensInState(
    ctx,
    token.sessionId,
    "issued",
  )) {
    if (row._id === token._id) continue;
    await ctx.db.patch("refreshTokens", row._id, {
      state: "dropped",
      retiredAt: now,
    });
  }
  await ctx.db.patch("refreshTokens", token._id, { state: "redeemed" });

  // Remove any spent and dropped tokens past the `SPENT_TOKEN_HORIZON_MS`.
  await pruneRetiredTokens(ctx, token.sessionId, now);
}

/**
 * Exchange a refresh token for a fresh access token and a newly issued
 * refresh token.
 *
 * A token is redeemed the first time it is presented, and stays valid until a
 * token issued after it is redeemed. The presented token is one of (see the
 * schema for the states):
 *
 *  * `issued`: redeem it, then issue a new token as below.
 *  * `redeemed`: issue a new token and leave this one redeemed. A client whose
 *    response was lost still holds a valid token, however long it waits before
 *    trying again.
 *  * `spent` or `dropped`: the session's holders have diverged, which is what
 *    a stolen token looks like. Revoke the session.
 *  * Unknown, or expired: report no session.
 *
 * The outcomes are the arms of {@link vRefreshResult}: `rotated` carries the
 * new refresh token to persist, and `noSession` means the client must reflect
 * being signed out.
 *
 * Racers presenting the same issued token are serialized: the first redeems
 * it, and the rest find it redeemed. Each racer gets its own issued token, and
 * within `REFRESH_GRACE_MS` of the redemption they don't count against
 * `STANDARD_ISSUED_REFRESH_TOKEN_LIMIT`. Whichever one the client keeps is
 * redeemed on its next refresh, and the rest are dropped without ever being
 * presented.
 */
export const refresh = mutation({
  args: {
    refreshToken: v.string(),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vRefreshResult,
  handler: async (ctx, args): Promise<RefreshResult> => {
    // Resolve the TTL config well before use below - it does some validation
    // of the config that will throw if invalid, and that should be
    // unconditional.
    const ttl = resolveTtlConfig(args);
    const now = Date.now();

    const token = await lookupRefreshTokenByHash(
      ctx,
      await sha256Hex(args.refreshToken),
    );
    // A token this component has no record of ever issuing, or one retired
    // past the detection horizon. Revoking anything here would let anyone sign
    // anyone else out by presenting a made-up string, so an unknown token
    // reports no session and changes nothing.
    if (token === null) return { kind: "noSession" };

    switch (token.state) {
      case "spent":
      case "dropped":
        console.warn(
          (token.state === "dropped"
            ? "Dropped refresh token used: a sibling was already redeemed, " +
              "so the session has forked. "
            : "Spent refresh token used: a later token was already redeemed. ") +
            "Deleting the associated session. This could be due to a bug or " +
            "a leaked refresh token.",
        );
        await deleteSession(ctx, token.sessionId);
        return { kind: "noSession" };
      case "issued":
      case "redeemed":
        break;
    }

    if (token.expiresAt <= now) {
      await deleteSession(ctx, token.sessionId);
      return { kind: "noSession" };
    }
    if (token.state === "issued") {
      await redeem(ctx, token, now);
    } else {
      // Every issued token descends from the redeemed one, and the oldest was
      // issued when it was redeemed. Issued rows have no `retiredAt`, so the
      // index orders them by `_creationTime`, oldest first, and reading up to
      // the limit is enough to both date the redemption and check the count.
      const issued = await ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q) =>
          q.eq("sessionId", token.sessionId).eq("state", "issued"),
        )
        .take(STANDARD_ISSUED_REFRESH_TOKEN_LIMIT);
      if (
        issued.length >= STANDARD_ISSUED_REFRESH_TOKEN_LIMIT &&
        now - issued[0]._creationTime > REFRESH_GRACE_MS
      ) {
        console.warn(
          `Refresh token used with at least ${issued.length} issued tokens never ` +
            "redeemed: deleting the associated session. This could be due to " +
            "a bug or a leaked refresh token.",
        );
        await deleteSession(ctx, token.sessionId);
        return { kind: "noSession" };
      }
    }

    // Every refresh token row is deleted along with its session, so if we found
    // the token, the session also exists. Note that a refresh never writes the
    // session row: queries that read it (e.g. to check session liveness) stay
    // cached across token refreshes.
    const session = (await ctx.db.get("sessions", token.sessionId))!;
    const { refreshToken, expiresAt } = await issueRefreshToken(
      ctx,
      session._id,
      now,
      ttl,
    );
    const accessToken = await mintAccessToken(
      ctx,
      session._id,
      ttl.accessTokenTtlSeconds,
    );
    return {
      kind: "rotated",
      tokens: {
        accessToken,
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
        userId: session.userId,
      },
    };
  },
});

/**
 * Revoke a session (sign out). Idempotent.
 *
 * Any token the session remembers will do, whatever its state: a client
 * usually holds an issued token it hasn't redeemed yet, and one signing out
 * just after a sibling tab refreshed may hold a spent one. Either is a real
 * sign-out request.
 */
export const signOut = mutation({
  args: { refreshToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await lookupRefreshTokenByHash(
      ctx,
      await sha256Hex(args.refreshToken),
    );
    if (token !== null) await deleteSession(ctx, token.sessionId);
    return null;
  },
});

/**
 * List every session of a user, with when it last refreshed and when it
 * expires.
 *
 * Both come from the session's newest issued refresh token:
 *
 *  - `lastRefreshedAt` is when it was issued: the session's sign-in or its
 *    latest refresh. A connected client refreshes about once per access-token
 *    TTL, so callers may read this as a rough activity signal, but it tracks
 *    the client holding the session, not user interaction.
 *  - `expiresAt` is its expiry: the time after which the holder can no longer
 *    refresh.
 *
 * A session with no issued token is left out with a warning. The token
 * lifecycle never leaves one (sign-in and each refresh issue a token), so
 * finding one means a bug.
 *
 * Sessions are listed newest first.
 *
 * Expired sessions are included, since a session's row outlives its tokens
 * until something deletes it. The query does not read the clock, so its result
 * stays cached until a session or token changes; callers that want only the
 * active sessions compare `expiresAt` to the current time themselves.
 *
 * This is a component function callable by the app, not by end-user clients.
 */
export const listSessions = query({
  args: { userId: v.string() },
  returns: v.array(
    v.object({
      sessionId: v.string(),
      creationTime: v.number(),
      lastRefreshedAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    const result = [];
    for (const session of sessions) {
      // Issued rows have no `retiredAt`, so the index orders them by
      // `_creationTime`: the last one is the newest.
      const newestIssued = await ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q) =>
          q.eq("sessionId", session._id).eq("state", "issued"),
        )
        .order("desc")
        .first();
      if (newestIssued === null) {
        console.warn(
          `Session ${session._id} has no issued refresh token, which should ` +
            "be impossible. Leaving it out of the session list.",
        );
        continue;
      }
      result.push({
        sessionId: session._id,
        creationTime: session._creationTime,
        lastRefreshedAt: newestIssued._creationTime,
        expiresAt: newestIssued.expiresAt,
      });
    }
    return result;
  },
});

/**
 * Revoke sessions, erasing each along with its refresh tokens, so their
 * holders can no longer refresh.
 *
 * Returns the ids of the sessions that existed and were revoked. An id that is
 * no session (malformed, already revoked, or repeated in `sessionIds`) is
 * skipped.
 *
 * This is a component function callable by the app, not by end-user clients.
 *
 * NOTE: This does no authorization: it revokes any session it is given,
 * whichever user it belongs to. Callers decide which sessions may be revoked;
 * e.g. revoking a user's other sessions should only follow a check that the
 * signed-in user truly owns the current session, via confirming an
 * authentication method. Otherwise, the request might be originating from a
 * stolen session, which shouldn't be able to revoke other sessions.
 */
// TODO: when we have step-up auth revoking sessions should check its state,
// rather than count on callers to safely invoke it.
export const revokeSessions = mutation({
  args: { sessionIds: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const revoked: string[] = [];
    for (const rawId of args.sessionIds) {
      const sessionId = ctx.db.normalizeId("sessions", rawId);
      if (
        sessionId === null ||
        (await ctx.db.get("sessions", sessionId)) === null
      ) {
        continue;
      }
      await deleteSession(ctx, sessionId);
      revoked.push(sessionId);
    }
    return revoked;
  },
});
