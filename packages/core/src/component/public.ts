import { mutation, query, MutationCtx } from "./_generated/server.ts";
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
  type CreateUserFn,
  type OnSignInFn,
} from "../lib/types.ts";
import { sha256Hex } from "../lib/crypto.ts";
import {
  assertMountedAsCore,
  CORE_COMPONENT_PATH,
} from "../lib/coreComponent.ts";
import {
  recordTtlConfig,
  refreshTokenInactivityExpiresAt,
  sessionMaxLifetimeExpiresAt,
} from "./expiry.ts";
import {
  type TtlConfig,
  validateTtlConfig,
  vTtlConfigFields,
} from "../lib/ttl.ts";
import {
  IMPERSONATION_STOP_GRACE_MS,
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
  REFRESH_GRACE_MS,
  deleteSession,
  deleteSingleSession,
  evictLeastRecentlyRefreshedSessions,
  isStoppedImpersonation,
  issueRefreshToken,
  liveImpersonation,
  lookupRefreshTokenByHash,
  newestIssuedToken,
  redeem,
  sessionTokensInState,
} from "./sessions.ts";
import { internal } from "./_generated/api.ts";

// --- Configuration ---------------------------------------------------------

// `aud` claim; must match `applicationID` in the app's auth.config.ts.
const AUDIENCE = "convex-auth";

// The `iss` claim is set by the deployment when this component calls
// `ctx.auth.signJwt`: `${CONVEX_CLOUD_URL}/components/auth`, which is what the
// app's auth.config.ts must name as the issuer. The app must mount the core at
// `auth` (see `CORE_COMPONENT_PATH`).

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
  const token = await ctx.auth.signJwt({
    claims: { sub: sessionId, aud: AUDIENCE },
    expiresInSeconds: ttlSeconds,
  });
  assertMountedAsCore(token);
  return token;
}

async function issueSession(
  ctx: MutationCtx,
  userId: string,
  component: string,
  ttl: TtlConfig,
): Promise<TokenBundle> {
  const now = Date.now();
  await recordTtlConfig(ctx, ttl);
  await evictLeastRecentlyRefreshedSessions(ctx, userId);
  const sessionId = await ctx.db.insert("sessions", {
    userId,
    component,
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
 * Create the app user for a new identity with the app's `createUser`
 * callback, and return its id.
 */
async function createAppUser(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUser: CreateUserFunctionHandle,
): Promise<string> {
  return await ctx.runMutation(createUser, {
    method: {
      name: claims.method,
      profile: claims.profile,
    },
  });
}

/** Add the user to `createdUserIds`, if it is not there yet. */
async function recordCreatedUserId(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  const existing = await ctx.db
    .query("createdUserIds")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (existing === null) {
    await ctx.db.insert("createdUserIds", { userId });
  }
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
    method: {
      name: claims.method,
      profile: claims.profile,
    },
    userId: asUserId(userId),
  });
}

/**
 * What the app may know about an impersonation session: who started it and
 * when it ends.
 */
const vImpersonationDetails = v.object({
  impersonatorUserId: v.string(),
  expiresAt: v.number(),
});

/** The `impersonation` field of a session as the app sees it, if it has one. */
function impersonationDetails(session: Doc<"sessions">): {
  impersonation?: { impersonatorUserId: string; expiresAt: number };
} {
  if (session.impersonation === undefined) return {};
  const { impersonatorUserId, expiresAt } = session.impersonation;
  return { impersonation: { impersonatorUserId, expiresAt } };
}

/**
 * Whether a session can no longer be refreshed under the given lifetimes: it
 * went a whole inactivity timeout without a refresh since `lastRefreshedAt`,
 * or it is past its max lifetime.
 */
function isSessionExpired(
  session: Doc<"sessions">,
  lastRefreshedAt: number,
  ttl: TtlConfig,
  now: number,
): boolean {
  return (
    refreshTokenInactivityExpiresAt(
      { _creationTime: lastRefreshedAt },
      ttl.refreshInactivityTimeoutSeconds,
    ) <= now ||
    sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds) <= now
  );
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
 * The core doesn't track identities, so a repeated sign-up creates another
 * user. The sign-in method must check its own component for the identity
 * first, and record the returned `userId` there in the same mutation.
 *
 * The JWT accessToken in the return value is signed by the deployment, with
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`. The token and session lifetimes
 * are the app's configuration, which `setupConvexAuth` resolves and passes in.
 *
 * `componentPath` is the path of the component that authenticated the user, for
 * example `"authPassword"`. The session records it as its `component`.
 *
 * See {@link _internal_dangerous_signIn} for the return-visit path.
 *
 * DANGER: This trusts `claims`, which reach the app's `createUser` and
 * `onSignIn`. The name says so because app code must not call it: only
 * the sign-in methods of this package do, right after they verify the user.
 */
export const _internal_dangerous_signUp = mutation({
  args: {
    claims: vAuthClaims,
    componentPath: v.string(),
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
    await recordCreatedUserId(ctx, userId);
    await notifySignIn(ctx, args.claims, userId, args.onSignInHandle);
    return await issueSession(ctx, userId, args.componentPath, ttl);
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
 * The core doesn't check `userId`, so a wrong `userId` signs the caller in as
 * that user. Sign-in methods must pass only a user id they looked up after
 * verifying the identity.
 *
 * DANGER: This mints a session for any `userId`. The name says so because
 * app code must not call it: only the sign-in methods of this package do,
 * right after they verify the user.
 *
 * `componentPath` is the path of the component that authenticated the user, for
 * example `"authPassword"`. The session records it as its `component`.
 *
 * The JWT accessToken in the return value is signed by the deployment, with
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`. The token and session lifetimes
 * are the app's configuration, which `setupConvexAuth` resolves and passes in.
 */
export const _internal_dangerous_signIn = mutation({
  args: {
    claims: vAuthClaims,
    componentPath: v.string(),
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
    await recordCreatedUserId(ctx, userId);
    await notifySignIn(ctx, claims, userId, args.onSignInHandle);
    return await issueSession(ctx, userId, args.componentPath, ttl);
  },
});

/**
 * Create the app user for the verified identity claims of a sign-in method
 * without minting a session.
 *
 * Sign-in methods use this (via the `signUpWithoutSession` helper the core
 * hands them) when the user must complete a step before the first sign-in — for
 * example, an email validation. The app's `createUser` mutation creates the
 * user, as for `_internal_dangerous_signUp`. No session is minted and `onSignIn` doesn't
 * run, so the user can't make authenticated calls until a later
 * `_internal_dangerous_signIn` succeeds. The caller must record the returned `userId` in
 * its own component.
 *
 * DANGER: This trusts `claims`, which reach the app's `createUser`. The name
 * says so because app code must not call it: only the sign-in methods of this
 * package do, right after they verify the user.
 */
export const _internal_dangerous_signUpWithoutSession = mutation({
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
    await recordCreatedUserId(ctx, userId);
    return { userId };
  },
});

/**
 * The outcome of {@link _internal_dangerous_stopImpersonation}:
 *
 *  * `restored`: `tokens` is a session bundle of the impersonator.
 *  * `notImpersonating`: the session is gone or is not an impersonation, or a
 *    client already received the result of an earlier stop and refreshed with
 *    it.
 *  * `impersonatorSessionEnded`: the impersonation reached its `expiresAt`, or
 *    the session of the impersonator is gone or expired. Both sessions are
 *    deleted.
 */
const vStopImpersonationResult = v.union(
  v.object({ kind: v.literal("restored"), tokens: vTokenBundle }),
  v.object({ kind: v.literal("notImpersonating") }),
  v.object({ kind: v.literal("impersonatorSessionEnded") }),
);

/**
 * Start an impersonation: mint a session of `targetUserId` on behalf of the
 * user of `impersonatorSessionId`.
 *
 * Apps don't call this API directly; a trusted server wrapper must verify the
 * caller's session and check the app's authorization rule before calling it.
 *
 * The new session is an impersonation session. It ends at the sooner of
 * `maxDurationSeconds` from now and the max lifetime of the impersonator
 * session. The impersonator session is suspended while it lasts (see
 * {@link refresh}), and the two sessions end together (see `deleteSession`).
 * `onSignIn` does not run: the target did not sign in.
 *
 * Throws when the impersonator session is gone or expired, is itself an
 * impersonation, already has an impersonation that is not stopped, or belongs
 * to the target user. The caller turns the cases a client can reach into typed
 * errors before invoking this mutation.
 *
 * The core doesn't check that `targetUserId` exists, like
 * {@link _internal_dangerous_signIn}.
 *
 * DANGER: This mints a session for any `targetUserId`, and trusts that the
 * caller owns `impersonatorSessionId` and is authorized to impersonate. App
 * code must never expose it directly.
 */
export const _internal_dangerous_impersonate = mutation({
  args: {
    impersonatorSessionId: v.string(),
    targetUserId: v.string(),
    maxDurationSeconds: v.number(),
    ...vTtlConfigFields,
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = validateTtlConfig(args);
    const { targetUserId, maxDurationSeconds } = args;
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      throw new Error("The impersonation duration must be a positive number.");
    }
    if (targetUserId === "") {
      throw new Error("Cannot impersonate: no user id was given.");
    }
    const now = Date.now();
    const impersonatorSessionId = ctx.db.normalizeId(
      "sessions",
      args.impersonatorSessionId,
    );
    const impersonatorSession =
      impersonatorSessionId === null
        ? null
        : await ctx.db.get("sessions", impersonatorSessionId);
    if (impersonatorSession === null) {
      throw new Error("Cannot impersonate: the caller has no session.");
    }
    if (impersonatorSession.impersonation !== undefined) {
      throw new Error(
        "Cannot impersonate from an impersonation session. Stop the current " +
          "impersonation first.",
      );
    }
    if (impersonatorSession.userId === targetUserId) {
      throw new Error("A user cannot impersonate themself.");
    }
    // The row of an expired session stays until something deletes it, and its
    // last access token can still be valid.
    const newestIssued = await newestIssuedToken(ctx, impersonatorSession._id);
    if (
      newestIssued === null ||
      isSessionExpired(
        impersonatorSession,
        newestIssued._creationTime,
        ttl,
        now,
      )
    ) {
      throw new Error("Cannot impersonate: the caller's session has expired.");
    }
    // The honest client holds the tokens of its impersonation, and its tabs
    // take turns to switch sessions, so only a replayed access token of the
    // impersonator session gets here.
    const earlierImpersonations = await ctx.db
      .query("sessions")
      .withIndex("by_impersonatorSession", (q) =>
        q.eq("impersonation.impersonatorSessionId", impersonatorSession._id),
      )
      .collect();
    if (
      earlierImpersonations.some((session) => !isStoppedImpersonation(session))
    ) {
      throw new Error(
        "Cannot impersonate: this session already has an impersonation. " +
          "Stop it first.",
      );
    }
    // The stopped ones, still in their grace period, can no longer restore
    // the impersonator session (see `_internal_dangerous_stopImpersonation`).
    for (const { _id, impersonation } of earlierImpersonations) {
      if (
        impersonation !== undefined &&
        impersonation.supersededAt === undefined
      ) {
        await ctx.db.patch("sessions", _id, {
          impersonation: { ...impersonation, supersededAt: now },
        });
      }
    }

    await recordTtlConfig(ctx, ttl);
    await evictLeastRecentlyRefreshedSessions(ctx, targetUserId);
    const sessionId = await ctx.db.insert("sessions", {
      userId: targetUserId,
      component: CORE_COMPONENT_PATH,
      impersonation: {
        impersonatorUserId: impersonatorSession.userId,
        impersonatorSessionId: impersonatorSession._id,
        expiresAt: Math.min(
          now + maxDurationSeconds * 1000,
          sessionMaxLifetimeExpiresAt(
            impersonatorSession,
            ttl.sessionMaxLifetimeSeconds,
          ),
        ),
      },
    });
    const session = (await ctx.db.get("sessions", sessionId))!;
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
      userId: targetUserId,
    };
  },
});

/**
 * Stop an impersonation: end the impersonation session `sessionId` and resume
 * the session of the impersonator who started it.
 *
 * Apps don't call this API directly; a trusted server wrapper must pass the
 * session id of the caller's verified access token.
 *
 * Resolves to one of the arms of {@link vStopImpersonationResult}.
 *
 * The impersonator's client dropped the refresh token of its own session when
 * it adopted the impersonation, and the core stores only hashes. So this
 * issues a new refresh token in the impersonator session. The first stop of an
 * impersonation retires every token that session held before (issued tokens
 * become `dropped`, and any previously redeemed token becomes `spent`): nobody
 * should present them again, and whoever does forks the session, which revokes
 * it (see {@link refresh}).
 *
 * The impersonation session is not deleted here. It is marked as stopped and
 * scheduled for deletion `IMPERSONATION_STOP_GRACE_MS` later (and refused past
 * that deadline even if deletion is delayed). Until then:
 *
 *  * the clients still connected with its access token keep resolving to a
 *    user, so they are not signed out before they adopt the new tokens;
 *  * a stop whose response was lost can be repeated. The repeat issues one
 *    more token and retires nothing, so every response holds a valid token,
 *    and the first refresh with one of them drops the others. Once a
 *    restoration token has been redeemed, or the impersonator session has
 *    started another impersonation, a repeat issues nothing.
 *
 * The impersonator session's inactivity timeout counts from the last refresh
 * of either session, because the same client held both.
 *
 * DANGER: This mints a session of the impersonator for whoever passes
 * `sessionId`. App code must never expose it directly: only call it with the
 * session id of the caller's verified access token.
 */
export const _internal_dangerous_stopImpersonation = mutation({
  args: {
    sessionId: v.string(),
    ...vTtlConfigFields,
  },
  returns: vStopImpersonationResult,
  handler: async (ctx, args) => {
    const ttl = validateTtlConfig(args);
    const now = Date.now();
    await recordTtlConfig(ctx, ttl);
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    const session =
      sessionId === null ? null : await ctx.db.get("sessions", sessionId);
    if (session === null || session.impersonation === undefined) {
      return { kind: "notImpersonating" as const };
    }
    if (
      session.impersonation.stoppedAt !== undefined &&
      session.impersonation.stoppedAt + IMPERSONATION_STOP_GRACE_MS <= now
    ) {
      await deleteSingleSession(ctx, session._id);
      return { kind: "notImpersonating" as const };
    }
    const impersonatorSession = await ctx.db.get(
      "sessions",
      session.impersonation.impersonatorSessionId,
    );
    // The impersonator session can only be gone when this session is stopped:
    // otherwise the two are deleted together.
    if (impersonatorSession === null) {
      await deleteSingleSession(ctx, session._id);
      return { kind: "impersonatorSessionEnded" as const };
    }
    // Only the newest impersonation of a session can restore it, or judge
    // whether it expired: the newer one's refreshes count, and only it sees
    // them.
    if (session.impersonation.supersededAt !== undefined) {
      return { kind: "notImpersonating" as const };
    }
    if (
      !isStoppedImpersonation(session) &&
      session.impersonation.expiresAt <= now
    ) {
      await deleteSession(ctx, session._id);
      return { kind: "impersonatorSessionEnded" as const };
    }
    const lastRefreshedAt = Math.max(
      (await newestIssuedToken(ctx, impersonatorSession._id))?._creationTime ??
        -Infinity,
      (await newestIssuedToken(ctx, session._id))?._creationTime ?? -Infinity,
    );
    if (isSessionExpired(impersonatorSession, lastRefreshedAt, ttl, now)) {
      await deleteSingleSession(ctx, session._id);
      await deleteSession(ctx, impersonatorSession._id);
      return { kind: "impersonatorSessionEnded" as const };
    }

    const issued = await sessionTokensInState(
      ctx,
      impersonatorSession._id,
      "issued",
    );
    const redeemedTokens = await sessionTokensInState(
      ctx,
      impersonatorSession._id,
      "redeemed",
    );
    if (!isStoppedImpersonation(session)) {
      for (const token of issued) {
        await ctx.db.patch("refreshTokens", token._id, {
          state: "dropped",
          retiredAt: now,
        });
      }
      for (const token of redeemedTokens) {
        await ctx.db.patch("refreshTokens", token._id, {
          state: "spent",
          retiredAt: now,
        });
      }
      await ctx.db.patch("sessions", session._id, {
        impersonation: {
          ...session.impersonation,
          stoppedAt: now,
        },
      });
      await ctx.scheduler.runAfter(
        IMPERSONATION_STOP_GRACE_MS,
        internal.sessions.deleteStoppedImpersonation,
        { sessionId: session._id },
      );
    } else {
      // The first stop retired every pre-stop token of the impersonator
      // session (issued -> dropped, redeemed -> spent), so a redeemed token
      // now can only mean a client received an earlier restoration response
      // and refreshed with it.
      if (redeemedTokens.length > 0) {
        return { kind: "notImpersonating" as const };
      }
      if (issued.length >= STANDARD_ISSUED_REFRESH_TOKEN_LIMIT) {
        throw new Error(
          "This impersonation was stopped already, too many times to issue " +
            "another session.",
        );
      }
    }

    const { refreshToken, expiresAt } = await issueRefreshToken(
      ctx,
      impersonatorSession,
      now,
      ttl,
    );
    const accessToken = await mintAccessToken(
      ctx,
      impersonatorSession._id,
      ttl.accessTokenTtlSeconds,
    );
    return {
      kind: "restored" as const,
      tokens: {
        accessToken,
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
        userId: impersonatorSession.userId,
      },
    };
  },
});

/**
 * Record that a user exists.
 *
 * The core records the users that it creates and signs in. Call this function
 * for the other users: the users that the app imports or creates without the
 * core, and the users that existed before the app upgraded to this version.
 *
 * Any code of the app can call this function. That is safe: it only records
 * that an ID is in use.
 */
export const markUserIdCreated = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    if (userId === "") {
      throw new Error("Cannot mark an empty user ID as created.");
    }
    await recordCreatedUserId(ctx, userId);
    return null;
  },
});

/**
 * Look up a live session by its id.
 *
 * Returns an object with the session's `userId` when the session row exists.
 * If there is no row for the session id, it returns `null`.
 *
 * For an impersonation session, `userId` is the impersonated user, and
 * `impersonation` names the user who started it and when it ends.
 *
 * A session is live exactly as long as its row exists: sign-out, refresh-token
 * reuse detection, and expired-token cleanup all delete the row.
 *
 * This is a component function; it is callable by the app, not by end-user
 * clients, so it does not expose session existence to the outside world.
 */
export const getSession = query({
  args: { sessionId: v.string() },
  returns: v.union(
    v.object({
      userId: v.string(),
      impersonation: v.optional(vImpersonationDetails),
    }),
    v.null(),
  ),
  handler: async (ctx, { sessionId }) => {
    const id = ctx.db.normalizeId("sessions", sessionId);
    if (id === null) return null;
    const session = await ctx.db.get("sessions", id);
    if (session === null) return null;
    // Scheduled deletion (`deleteStoppedImpersonation`) is what reactively
    // wakes subscribed queries at the end of the grace period; this clock
    // check covers fresh reads and mutations if that job is delayed.
    if (
      session.impersonation?.stoppedAt !== undefined &&
      session.impersonation.stoppedAt + IMPERSONATION_STOP_GRACE_MS <=
        Date.now()
    ) {
      return null;
    }
    return {
      userId: session.userId,
      ...impersonationDetails(session),
    };
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
 * Impersonation adds three rules, checked after reuse detection:
 *
 *  * A session that started an impersonation which is not stopped is
 *    suspended: report no session, and revoke nothing.
 *  * An impersonation session past its `expiresAt`, or whose impersonator
 *    session is past its max lifetime: revoke both sessions.
 *  * A stopped impersonation session refreshes like any other session during
 *    its `IMPERSONATION_STOP_GRACE_MS` grace period, and ends once that
 *    deadline passes even if its scheduled deletion has not run yet.
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
    await recordTtlConfig(ctx, ttl);

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

    // Reuse detection comes before every other check, so that nothing below
    // hides a replayed token.
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

    // A session that started an impersonation is suspended until the
    // impersonation stops: the browser holds one identity at a time, and the
    // honest client replaced this session's tokens when the impersonation
    // started. A token presented now is a stale copy (for example a cookie
    // that a crossing server-side refresh wrote back), so it gets no session,
    // and nothing is revoked. A refresh that was already under way when the
    // impersonation started still gets `REFRESH_GRACE_MS` to land.
    if (session.impersonation === undefined) {
      const impersonation = await liveImpersonation(ctx, session._id);
      if (
        impersonation !== null &&
        now - impersonation._creationTime > REFRESH_GRACE_MS
      ) {
        return { kind: "noSession" };
      }
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
    // An impersonation ends at its `expiresAt`, and never outlives the max
    // lifetime of the impersonator session under the current configuration.
    // A stopped one refreshes during its grace period so a refresh crossing
    // the stop does not sign the client out, but never past the deadline even
    // if the scheduled deletion is delayed.
    if (session.impersonation !== undefined) {
      if (session.impersonation.stoppedAt !== undefined) {
        if (
          session.impersonation.stoppedAt + IMPERSONATION_STOP_GRACE_MS <=
          now
        ) {
          await deleteSingleSession(ctx, session._id);
          return { kind: "noSession" };
        }
      } else {
        const impersonatorSession = await ctx.db.get(
          "sessions",
          session.impersonation.impersonatorSessionId,
        );
        if (
          session.impersonation.expiresAt <= now ||
          impersonatorSession === null ||
          sessionMaxLifetimeExpiresAt(
            impersonatorSession,
            ttl.sessionMaxLifetimeSeconds,
          ) <= now
        ) {
          await deleteSession(ctx, session._id);
          return { kind: "noSession" };
        }
      }
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
 * An impersonation session of the user (one where somebody else acts as the
 * user) is listed too, with its `impersonation`. Its `expiresAt` tells whether
 * it is over. A session of the user that is suspended while the user
 * impersonates somebody does not refresh, so its `lastRefreshedAt` stands
 * still for as long as the impersonation lasts.
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
      impersonation: v.optional(vImpersonationDetails),
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
        ...impersonationDetails(session),
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
 * An impersonation session and the session of the impersonator who started it
 * end together, so revoking either one also revokes the other. The other one
 * is not in the returned ids unless it was given too. A stopped impersonation
 * is the exception: revoking it leaves the impersonator session.
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
    // Find every given session before deleting any: deleting one session of
    // an impersonation also deletes the other, which may be given too.
    const revoked: Id<"sessions">[] = [];
    for (const rawId of args.sessionIds) {
      const sessionId = ctx.db.normalizeId("sessions", rawId);
      if (
        sessionId === null ||
        revoked.includes(sessionId) ||
        (await ctx.db.get("sessions", sessionId)) === null
      ) {
        continue;
      }
      revoked.push(sessionId);
    }
    for (const sessionId of revoked) {
      await deleteSession(ctx, sessionId);
    }
    return revoked;
  },
});
