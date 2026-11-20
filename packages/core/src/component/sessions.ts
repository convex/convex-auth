// Sessions and the lifecycle of their refresh tokens: issuing, redeeming,
// retiring, and erasing them. The public functions in public.ts build on these.

import { v } from "convex/values";
import { internal } from "./_generated/api.ts";
import type { Doc, Id } from "./_generated/dataModel.ts";
import { internalMutation } from "./_generated/server.ts";
import type { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { generateRefreshToken } from "./crypto.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { sessionMaxLifetimeExpiresAt } from "./expiry.ts";
import type { TtlConfig } from "../lib/ttl.ts";

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
// An absolute cap on how many sessions a user may have. A sign-in that would
// exceed it first revokes the sessions that refreshed longest ago. This bounds
// everything that reads all of a user's sessions (`listSessions`, and revoking
// a user's other sessions), which a user whose sessions pile up (e.g. a script
// signing in over and over and not refreshing a prior session) could otherwise
// push past the transaction's limits.
export const MAX_SESSIONS_PER_USER = 100;
// How long a stopped impersonation session stays before it is deleted. The
// clients that were using it are still connected with its access token when the
// stop commits. Its row stays this long so that they keep resolving to a user
// until they have adopted the impersonator's tokens, and so that a stop whose
// response was lost can be retried.
export const IMPERSONATION_STOP_GRACE_MS = 10 * 1000; // 10 seconds

/** Look up a refresh token, in any state, by its hash. */
export function lookupRefreshTokenByHash(
  ctx: QueryCtx,
  hash: string,
): Promise<Doc<"refreshTokens"> | null> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
}

/** A session's refresh tokens in one state. */
export function sessionTokensInState(
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
 * The session's newest issued refresh token: the one from its sign-in or its
 * latest refresh. It is the session's last token to go idle, thus the session
 * goes idle with it (unless its max lifetime ends it first).
 *
 * `null` only for a session with no issued token, which the token lifecycle
 * never leaves (sign-in and each refresh issue one).
 */
export async function newestIssuedToken(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"refreshTokens"> | null> {
  // Issued rows have no `retiredAt`, so the index orders them by
  // `_creationTime`: the last one is the newest.
  return await ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) =>
      q.eq("sessionId", sessionId).eq("state", "issued"),
    )
    .order("desc")
    .first();
}

/**
 * Make room for one more session of the user: while the user has
 * `MAX_SESSIONS_PER_USER` sessions or more, erase the one that refreshed
 * longest ago.
 *
 * A session's last refresh is when its newest issued token was issued (see
 * `listSessions`), so an expired or abandoned session goes before one that a
 * client still keeps fresh, however old that one is.
 */
export async function evictLeastRecentlyRefreshedSessions(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  // Reads every session of the user, which the cap keeps to
  // `MAX_SESSIONS_PER_USER`.
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const excess = sessions.length - MAX_SESSIONS_PER_USER + 1;
  if (excess <= 0) {
    return;
  }
  const byLastRefresh = [];
  for (const session of sessions) {
    const newestIssued = await newestIssuedToken(ctx, session._id);
    byLastRefresh.push({
      sessionId: session._id,
      // A session with no issued token can't refresh, so it goes first.
      lastRefreshedAt: newestIssued?._creationTime ?? -Infinity,
    });
  }
  // `sessions` is in creation order and the sort is stable, so of the
  // sessions that last refreshed at the same time, the oldest goes first.
  byLastRefresh.sort((a, b) => a.lastRefreshedAt - b.lastRefreshedAt);
  for (const { sessionId } of byLastRefresh.slice(0, excess)) {
    await deleteSession(ctx, sessionId);
  }
  console.warn(
    `Evicted ${excess} session${excess > 1 ? "s" : ""} past the ` +
      `${MAX_SESSIONS_PER_USER} session limit for a single user`,
  );
}

/**
 * Whether an impersonation session was stopped. A stopped one is only waiting
 * to be deleted: it is no longer tied to its impersonator session.
 */
export function isStoppedImpersonation(
  session: Pick<Doc<"sessions">, "impersonation">,
): boolean {
  return session.impersonation?.stoppedAt !== undefined;
}

/**
 * The impersonation session that the given session started and that is not
 * stopped, or `null`. A session has at most one.
 */
export async function liveImpersonation(
  ctx: QueryCtx,
  impersonatorSessionId: Id<"sessions">,
): Promise<Doc<"sessions"> | null> {
  // A stopped impersonation of the same session can sit beside the live one
  // until its grace period ends, so read them all and keep the live one.
  const impersonations = await ctx.db
    .query("sessions")
    .withIndex("by_impersonatorSession", (q) =>
      q.eq("impersonation.impersonatorSessionId", impersonatorSessionId),
    )
    .collect();
  return (
    impersonations.find((session) => !isStoppedImpersonation(session)) ?? null
  );
}

/**
 * Erase a session, and the session that must end with it.
 *
 * An impersonation session and its impersonator session end together, so that
 * neither is left where no client can reach it: erasing one erases the other.
 * A stopped impersonation session is the exception. It is erased alone.
 *
 * Idempotent, like {@link deleteSingleSession}.
 */
export async function deleteSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  const session = await ctx.db.get("sessions", sessionId);
  if (session === null) {
    return;
  }
  await deleteSingleSession(ctx, sessionId);
  if (session.impersonation === undefined) {
    const impersonation = await liveImpersonation(ctx, sessionId);
    if (impersonation !== null) {
      await deleteSingleSession(ctx, impersonation._id);
    }
  } else if (!isStoppedImpersonation(session)) {
    await deleteSingleSession(ctx, session.impersonation.impersonatorSessionId);
  }
}

/**
 * Erase one session, and schedule the erasure of every refresh token that
 * points at it. Use {@link deleteSession} unless the other session of an
 * impersonation must stay.
 *
 * The session ends when its row is gone: `refresh` refuses a token whose
 * session is gone, thus no token can be added to it again. Its token rows only
 * linger until `deleteSessionTokens` gets to them. That keeps this function at
 * a few reads and writes however many rows the session holds, so a mutation
 * can erase many sessions at once (e.g. revoking a user's other sessions on a
 * password reset) without exceeding the transaction's limits.
 *
 * Idempotent, because callers can race: two replays of the same stolen token,
 * or a sign-out arriving alongside one, can both resolve the same session.
 */
export async function deleteSingleSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  // `delete` throws on an id that is already gone, and the session may have
  // been deleted by whoever we raced, which also scheduled its tokens.
  if ((await ctx.db.get("sessions", sessionId)) === null) {
    return;
  }
  await ctx.db.delete("sessions", sessionId);
  await ctx.scheduler.runAfter(0, internal.sessions.deleteSessionTokens, {
    sessionId,
  });
}

// How many token rows one run of `deleteSessionTokens` erases, well within the
// transaction's limits.
const TOKEN_DELETION_BATCH_SIZE = 1000;

/**
 * Erase the refresh tokens of a deleted session, one batch at a time, and
 * schedule another run while more may remain.
 *
 * The session is gone, thus nothing adds a row to it, and the runs end.
 */
export const deleteSessionTokens = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const tokens = await ctx.db
      .query("refreshTokens")
      .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId))
      .take(TOKEN_DELETION_BATCH_SIZE);
    for (const row of tokens) {
      await ctx.db.delete("refreshTokens", row._id);
    }
    if (tokens.length === TOKEN_DELETION_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.sessions.deleteSessionTokens, {
        sessionId,
      });
    }
    return null;
  },
});

/**
 * Erase a stopped impersonation session once its grace period is over. The
 * impersonator session stays.
 */
export const deleteStoppedImpersonation = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get("sessions", sessionId);
    if (session !== null && isStoppedImpersonation(session)) {
      await deleteSingleSession(ctx, sessionId);
    }
    return null;
  },
});

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
export async function pruneRetiredTokens(
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
 * Issue a new refresh token for a session.
 *
 * Returns the raw token, and stores its hash for later lookup. The returned
 * `expiresAt` is the sooner of the token's inactivity expiry and the session's
 * max lifetime, and holds under the current config; a later change to either
 * moves it. An impersonation session that is not stopped also ends at its
 * `expiresAt`. The inactivity expiry is computed from `now` rather than the row's
 * `_creationTime`, so it can differ from what `refresh` enforces by a fraction
 * of a millisecond.
 */
export async function issueRefreshToken(
  ctx: MutationCtx,
  session: Pick<Doc<"sessions">, "_id" | "_creationTime" | "impersonation">,
  now: number,
  ttl: TtlConfig,
): Promise<{ refreshToken: string; expiresAt: number }> {
  const refreshToken = generateRefreshToken();
  await ctx.db.insert("refreshTokens", {
    hash: await sha256Hex(refreshToken),
    sessionId: session._id,
    state: "issued",
  });
  return {
    refreshToken,
    expiresAt: Math.min(
      now + ttl.refreshInactivityTimeoutSeconds * 1000,
      sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds),
      session.impersonation === undefined
        ? Infinity
        : session.impersonation.stoppedAt !== undefined
          ? session.impersonation.stoppedAt + IMPERSONATION_STOP_GRACE_MS
          : session.impersonation.expiresAt,
    ),
  };
}

/**
 * Redeem an issued token, the first time it is presented.
 *
 * Its holder has evidently received it, so the session's previously redeemed
 * token is marked as spent and the other issued tokens, which nobody should
 * ever present, are marked as dropped.
 */
export async function redeem(
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
