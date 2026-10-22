// The background loop that erases expired sessions. `refresh` refuses an
// expired token on its own, so the loop doesn't enforce expiry: it makes a
// session's row, which `getSession` reads for liveness, go away once the
// session can no longer refresh. Without it, the row of a session that nobody
// refreshes again would stay forever.
//
// A session expires one refresh-token TTL after its newest issued token was
// issued. The TTL is the app's config, which the app passes in as call args,
// thus the loop reads the copy that sign-in and refresh store (see
// `recordTtlConfig`). Each run reads it afresh, so a changed TTL applies to
// every session, in either direction.

import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";
import {
  refreshTokenExpiresAt,
  storedRefreshTokenTtlSeconds,
} from "./expiry.ts";
import { deleteSession, newestIssuedToken } from "./sessions.ts";

// The name of the batch worker loop that erases expired sessions. Only one
// loop is necessary, so the name is constant.
export const WORKER_NAME = "expiredSessions";

// How many expired issued tokens one worker mutation handles. Each one can
// erase a whole session, which reads and deletes every token row the session
// still remembers (a few dozen at the defaults, see `deleteSession`), thus the
// batch is smaller than the one of the email and passkey loops. The worker
// runs again immediately while more expired rows stay, so this value only
// sets the size of each transaction.
const BATCH_SIZE = 64;

// The longest the loop sleeps between checks. The next expiry is often a
// whole TTL away (30 days by default), which is longer than a JavaScript timer
// can wait (about 24.8 days; convex-test fires a longer one at once). A daily
// check costs one query, and it also bounds how late the loop notices
// anything that its wake-up time didn't account for.
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Make sure that the background cleanup loop runs.
 *
 * Call this function after a session starts, and after the stored TTL
 * changes. The call is cheap: it does nothing while the loop already runs or
 * waits. While any session exists, the loop sleeps until the next one may
 * expire; it goes idle when no session stays.
 *
 * A refresh doesn't ping: it only pushes its session's expiry later, and the
 * loop checks again when it wakes up.
 */
export async function scheduleSessionCleanup(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, {
    name: WORKER_NAME,
    workQuery: internal.cleanup.getExpiredTokens,
    workerMutation: internal.cleanup.deleteExpiredTokens,
  });
}

const vEvents = v.array(v.object({ id: v.id("refreshTokens") }));

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: { events: vEvents },
    // The cursor is the `_creationTime` of the last issued token that the
    // loop handled. Every issued token below it is gone (see
    // `deleteExpiredTokens`), thus the next scan starts at it and does not
    // read their tombstones.
    //
    // The batch worker docs warn that `_creationTime` is assigned when a
    // mutation starts, so a slow mutation can insert a row behind the cursor.
    // The scan only reads tokens older than one TTL, and no mutation runs
    // that long, thus no token can land behind it.
    cursor: v.number(),
  });

/**
 * Find the next batch of issued tokens that are past the TTL.
 *
 * A session's issued tokens are the ones from its sign-in or its refreshes
 * that nobody presented yet, and its newest token is always issued. Thus a
 * session whose every issued token is past the TTL is expired, and scanning
 * the issued tokens oldest first finds the expired sessions in the order in
 * which they expired.
 *
 * When no token is expired, the loop goes idle. If issued tokens stay, the
 * loop also gets a timeout: it wakes up again when the oldest of them expires
 * (or after `MAX_SLEEP_MS`, if sooner), even if no new session starts. That token may since have been redeemed, in
 * which case the wake-up finds nothing and sleeps until the next one.
 */
export const getExpiredTokens = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, args) => {
    const ttlSeconds = await storedRefreshTokenTtlSeconds(ctx);
    // No sign-in or refresh has stored a TTL yet, and those are what ping the
    // loop, thus this is only reachable through a manual start.
    if (ttlSeconds === null) {
      return { kind: "idle" as const };
    }
    const now = Date.now();
    // The upper bound keeps the read to the expired rows. The newest issued
    // tokens, the ones each refresh inserts, are past it, so this scan doesn't
    // touch the part of the index that refreshes write to.
    const expired = await ctx.db
      .query("refreshTokens")
      .withIndex("by_state", (q) =>
        q
          .eq("state", "issued")
          .eq("retiredAt", undefined)
          // The bound is inclusive because two rows can share a creation
          // time: the row at the cursor is erased, but a twin of it can stay.
          .gte("_creationTime", args.cursor ?? 0)
          // The boundary matches `refresh`: at exactly the TTL, a token is
          // expired. A wake-up at the deadline thus finds work.
          .lte("_creationTime", now - ttlSeconds * 1000),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { events: expired.map((row) => ({ id: row._id })) },
        // The component commits the cursor with the batch, thus it only moves
        // if the rows are really erased.
        cursor: expired[expired.length - 1]._creationTime,
      };
    }
    // Nothing to erase now. The oldest remaining issued token is the first
    // one that expires. No issued row below the cursor stays, thus the same
    // lower bound applies here. `first` reads only up to that row.
    const oldest = await ctx.db
      .query("refreshTokens")
      .withIndex("by_state", (q) =>
        q
          .eq("state", "issued")
          .eq("retiredAt", undefined)
          .gte("_creationTime", args.cursor ?? 0),
      )
      .first();
    if (oldest === null) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.min(
        MAX_SLEEP_MS,
        Math.max(0, refreshTokenExpiresAt(oldest, ttlSeconds) - Date.now()),
      ),
    };
  },
});

/**
 * Erase one batch of expired issued tokens, and with each session's newest
 * one, the session.
 *
 * The query ran on a snapshot that takes no read dependencies, thus each
 * token is checked again here. A token that was redeemed or retired since is
 * no longer this loop's to handle. A token that the stored TTL no longer
 * expires (it was raised in between) is kept, and the cursor is moved back to
 * it so that a later scan finds it again.
 *
 * An expired token that is not its session's newest issued one is a sibling
 * whose response was lost; the session lives on through the newer token.
 * Nobody can refresh with it any more, so only the token is erased. That
 * keeps the rule of the cursor: every issued token below it is gone.
 */
export const deleteExpiredTokens = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { events }) => {
    const ttlSeconds = await storedRefreshTokenTtlSeconds(ctx);
    if (ttlSeconds === null) {
      throw new Error(
        "Invariant violation: the session cleanup loop ran with no stored TTL",
      );
    }
    const now = Date.now();
    let keptFrom: number | undefined;
    for (const { id } of events) {
      const token = await ctx.db.get("refreshTokens", id);
      if (token === null || token.state !== "issued") continue;
      if (refreshTokenExpiresAt(token, ttlSeconds) > now) {
        keptFrom = Math.min(keptFrom ?? Infinity, token._creationTime);
        continue;
      }
      const newest = await newestIssuedToken(ctx, token.sessionId);
      if (newest?._id === token._id) {
        await deleteSession(ctx, token.sessionId);
      } else {
        await ctx.db.delete("refreshTokens", token._id);
      }
    }
    return keptFrom === undefined ? null : { cursor: keptFrom };
  },
});
