import { mutation, query, MutationCtx } from "./_generated/server.ts";
import { Id } from "./_generated/dataModel.ts";
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
  type CreateUserFn,
  type OnSignInFn,
} from "../lib/types.ts";
import { sha256Hex } from "../lib/crypto.ts";
import {
  refreshTokenInactivityExpiresAt,
  sessionMaxLifetimeExpiresAt,
} from "./expiry.ts";
import {
  type TtlConfig,
  validateTtlConfig,
  vTtlConfigFields,
} from "../lib/ttl.ts";
import {
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
  REFRESH_GRACE_MS,
  deleteSession,
  evictLeastRecentlyRefreshedSessions,
  issueRefreshToken,
  lookupRefreshTokenByHash,
  newestIssuedToken,
  redeem,
} from "./sessions.ts";

// --- Configuration ---------------------------------------------------------

// `aud` claim; must match `applicationID` in the app's auth.config.ts.
const AUDIENCE = "convex-auth";

// The `iss` claim is set by the deployment when this component calls
// `ctx.auth.signJwt`: `${CONVEX_CLOUD_URL}/components/auth`, which is what the
// app's auth.config.ts must name as the issuer.

// --- Internal helpers ------------------------------------------------------

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
  userId: string,
  provider: string,
  ttl: TtlConfig,
): Promise<TokenBundle> {
  const now = Date.now();
  await evictLeastRecentlyRefreshedSessions(ctx, userId);
  const sessionId = await ctx.db.insert("sessions", {
    userId,
    provider,
  });
  // Read back for its `_creationTime`, which its max lifetime counts from.
  const session = (await ctx.db.get("sessions", sessionId))!;
  // Issued like any other token: it is redeemed on the session's first
  // refresh.
  const { refreshToken, expiresAt } = await issueRefreshToken(
    ctx,
    session,
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
 * Mint the app-level user for an identity the method has not seen before.
 *
 * The app's `createUser` callback mints and returns the user id. The claims
 * are passed to it. The core records nothing: the method's component keeps
 * the map from its identity to this user id, and `signUp` and the sessionless
 * `signUpWithoutSession` both build on this.
 */
async function createAppUser(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUser: CreateUserFunctionHandle,
): Promise<string> {
  return await ctx.runMutation(createUser, {
    provider: {
      name: claims.providerName,
      accountId: claims.providerAccountId,
      profile: claims.profile,
    },
  });
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
 * Sign-in methods don't typically call this API directly, but instead use the
 * framework's `completeSignUp` helper. That function takes care of passing the
 * `createUserHandle` and `onSignInHandle` app callbacks.
 *
 * `createUser` mints the app user, then `onSignIn` runs like it does for any
 * other sign-in. An `onSignIn` that throws therefore rolls back the user
 * `createUser` just made, since both are subtransactions of this one.
 *
 * The core keeps no account for the identity: the caller records the
 * returned `userId` against it in the method's own component, in the same
 * mutation, so the two cannot disagree. The core therefore cannot refuse a
 * repeated sign-up of one identity; the method checks its component first.
 *
 * The JWT accessToken in the return value is signed by the deployment, with
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`. The token and session lifetimes
 * are the app's configuration, which `setupConvexAuth` resolves and passes in.
 *
 * See {@link signIn} for the return-visit path.
 */
export const signUp = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
    onSignInHandle: v.optional(v.string()),
    ...vTtlConfigFields,
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = validateTtlConfig(args);
    const userId = await createAppUser(
      ctx,
      args.claims,
      args.createUserHandle as CreateUserFunctionHandle,
    );
    await notifySignIn(ctx, args.claims, userId, args.onSignInHandle);
    return await issueSession(ctx, userId, args.claims.providerName, ttl);
  },
});

/**
 * Performs an app-integrated user sign-in of an existing user.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Sign-in methods don't typically call this API directly, but instead use the
 * framework's `completeSignIn` helper. That function takes care of passing the
 * `onSignInHandle` app callback.
 *
 * The caller has resolved the identity in `claims` to `userId` in the
 * method's own component; the core takes its word for it and records
 * nothing but the session. Reaching this function with a wrong `userId`
 * signs the caller in as that user, so a method only calls it with a user
 * id read from its component after verifying the identity.
 *
 * The JWT accessToken in the return value is signed by the deployment, with
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`. The token and session lifetimes
 * are the app's configuration, which `setupConvexAuth` resolves and passes in.
 */
export const signIn = mutation({
  args: {
    claims: vAuthClaims,
    userId: v.string(),
    onSignInHandle: v.optional(v.string()),
    ...vTtlConfigFields,
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = validateTtlConfig(args);
    const { claims, userId } = args;
    if (userId === "") {
      throw new Error("Cannot sign in: no user id was given.");
    }
    await notifySignIn(ctx, claims, userId, args.onSignInHandle);
    return await issueSession(ctx, userId, claims.providerName, ttl);
  },
});

/**
 * Create the app user for the verified identity claims of a method without
 * minting a session.
 *
 * Sign-in methods use this (via the `signUpWithoutSession` helper the core hands
 * them) when the user must complete a step before the first sign-in — for
 * example, an email validation. The app's `createUser` mutation mints the user,
 * as for `signUp`, but no session is minted and `onSignIn` does not run: the
 * user cannot make authenticated calls until a later `signIn` succeeds. The
 * caller records the returned `userId` against its identity in its own
 * component.
 */
export const signUpWithoutSession = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
  },
  returns: v.object({ userId: v.string() }),
  handler: async (ctx, args): Promise<{ userId: string }> => {
    // TODO: This API is kind of awkward. We might want to reconsider it before the GA v2 release.
    const userId = await createAppUser(
      ctx,
      args.claims,
      args.createUserHandle as CreateUserFunctionHandle,
    );
    return { userId };
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
 *  * Unknown, or expired (not refreshed within the refresh inactivity timeout,
 *    or past the session's max lifetime):
 *    report no session.
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
    ...vTtlConfigFields,
  },
  returns: vRefreshResult,
  handler: async (ctx, args): Promise<RefreshResult> => {
    // Validate the TTL config well before use below: an invalid one should
    // throw unconditionally.
    const ttl = validateTtlConfig(args);
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
    // A session's tokens are erased in the background after its row (see
    // `deleteSession`), so a token can outlive its session for a moment. The
    // session ended already, thus there is nothing to refresh or revoke.
    const session = await ctx.db.get("sessions", token.sessionId);
    if (session === null) return { kind: "noSession" };

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

    // A redeemed token's session last refreshed when it issued its newest
    // token, so date inactivity from that one.
    const lastIssued =
      token.state === "redeemed"
        ? ((await newestIssuedToken(ctx, session._id)) ?? token)
        : token;
    if (
      refreshTokenInactivityExpiresAt(
        lastIssued,
        ttl.refreshInactivityTimeoutSeconds,
      ) <= now ||
      sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds) <= now
    ) {
      await deleteSession(ctx, session._id);
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

    const { refreshToken, expiresAt } = await issueRefreshToken(
      ctx,
      session,
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
 * List every session of a user, with when it last refreshed.
 *
 * `lastRefreshedAt` is when the session's newest issued refresh token was
 * issued: the session's sign-in or its latest refresh. A connected client
 * refreshes about once per access-token TTL, so callers may read this as a
 * rough activity signal, but it tracks the client holding the session, not
 * user interaction.
 *
 * Sessions are listed newest first.
 *
 * Expired sessions are included, since a session's row outlives its tokens
 * until something deletes it. The query does not read the clock, so its result
 * stays cached until a session or token changes; callers that want only the
 * active sessions compare the expiry to the current time themselves.
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
      const newestIssued = await newestIssuedToken(ctx, session._id);
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
