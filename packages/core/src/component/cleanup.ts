// The background loop that erases expired sessions. `refresh` refuses an
// expired session on its own, so the loop doesn't enforce expiry: it makes a
// session's row, which `getSession` reads for liveness, go away once the
// session can no longer refresh. Without it, the row of a session that nobody
// refreshes again would stay forever.
//
// A session expires at the sooner of two deadlines: one inactivity timeout
// after its newest issued token was issued, or one max lifetime after it was
// created. The max-lifetime loop erases a session at the second, however
// recently it refreshed. It scans the sessions. Since the inactivity timeout
// is at most the max lifetime, every session the loop erases can no longer
// refresh, and every abandoned session is erased by its max lifetime at the
// latest. (The inactivity timeout defaults to the max lifetime, thus with the
// defaults the loop erases each abandoned session when it expires.)
//
// The lifetimes are the app's config, which the app passes in as call args,
// thus the loop reads the copy that sign-in and refresh store (see
// `recordTtlConfig`). Each run reads it afresh, so a changed lifetime applies
// to every session, in either direction.
//
// The loop is tuned to be conservative in batch size and throughput.
// Typically it processes few sessions at a time, but when many expire at once
// (e.g. after a lifetime is lowered), each erased session schedules the
// erasure of its tokens, so the loop paces itself to work through the
// backlog without swamping the scheduler (see `BATCH_INTERVAL_MS`).

import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";
import { sessionMaxLifetimeExpiresAt, storedTtlConfig } from "./expiry.ts";
import { deleteSession } from "./sessions.ts";

// The name of the batch worker loop that erases expired sessions. One loop is
// necessary, so the name is constant.
export const MAX_LIFETIME_WORKER_NAME = "maxLifetimeSessions";

// How many expired rows one worker mutation handles. Each one maps to a
// session, so this is effectively the max number of expired sessions
// deleted in a batch. Deleting a session takes a few reads and writes, and
// schedules the erasure of its refresh tokens (see `deleteSession`), so the
// batch stays far below the transaction's limit of 1000 scheduled functions.
// A mutation over the limits would throw on every retry, and the loop would
// hand out the same batch forever.
export const BATCH_SIZE = 100;

// How long the loop waits after a full batch before it handles the next one.
// Each erased session schedules one `deleteSessionTokens`, and the scheduler
// runs as few as 8 jobs at once (Free/Starter), a limit shared with the app's
// own scheduled functions. A large backlog of expired sessions (e.g. after a
// lifetime is lowered) would otherwise flood that queue as fast as the loop
// can find them. With the batch size, this caps the loop at 50 sessions per
// second. A batch that is not full drains the backlog, so the loop doesn't
// wait after it.
export const BATCH_INTERVAL_MS = 2_000;

/**
 * What a worker mutation returns to the batch worker: the cursor to move back
 * to, if it kept a row, and a wait before the next batch, if this one was full.
 */
function workerResult(
  batchLength: number,
  keptFrom: number | undefined,
): { cursor?: number; debounceMs?: number } | null {
  const full = batchLength >= BATCH_SIZE;
  if (keptFrom === undefined && !full) {
    return null;
  }
  return {
    ...(keptFrom !== undefined && { cursor: keptFrom }),
    ...(full && { debounceMs: BATCH_INTERVAL_MS }),
  };
}

// The longest the loop sleeps between checks. The next expiry is often a whole
// lifetime away (30 days by default), which is longer than a JavaScript timer
// can wait (about 24.8 days; convex-test fires a longer one at once). A daily
// check costs one query, and it also bounds how late the loop notices
// anything that its wake-up time didn't account for.
const MAX_SLEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Make sure that the background cleanup loop runs.
 *
 * Call this function after a session starts, and after the stored lifetimes
 * change. The call is cheap: it does nothing while the loop already runs or
 * waits. While any session exists, the loop sleeps until the next one reaches
 * the max lifetime; it goes idle when no session stays.
 *
 * A refresh doesn't ping: it never moves its session's max lifetime.
 */
export async function scheduleSessionCleanup(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, {
    name: MAX_LIFETIME_WORKER_NAME,
    workQuery: internal.cleanup.getSessionsPastMaxLifetime,
    workerMutation: internal.cleanup.deleteSessionsPastMaxLifetime,
  });
}

// --- The max-lifetime loop -------------------------------------------------

const vSessionEvents = v.array(v.object({ id: v.id("sessions") }));

const maxLifetimeValidators = defineBatchWorkerValidators({
  batch: { events: vSessionEvents },
  // The cursor is the `_creationTime` of the last session that the loop
  // handled. Every session below it is gone (see
  // `deleteSessionsPastMaxLifetime`), thus the next scan starts at it and
  // does not read their tombstones.
  //
  // The batch worker docs warn that `_creationTime` is assigned when a mutation
  // starts, so a slow mutation can insert a row behind the cursor. The scan
  // only reads sessions older than one max lifetime, and no mutation runs that
  // long, thus no session can land behind it.
  cursor: v.number(),
});

/**
 * Find the next batch of sessions that are past the max lifetime.
 *
 * Scanning the sessions oldest first finds them in the order in which they
 * reach it. When none is past it, the loop goes idle, with a timeout that
 * wakes it when the oldest remaining session reaches it (or after
 * `MAX_SLEEP_MS`, if sooner). That session may since have been erased
 * otherwise, in which case the wake-up finds nothing and sleeps until the
 * next one.
 */
export const getSessionsPastMaxLifetime = internalQuery({
  args: maxLifetimeValidators.vQueryArgs,
  returns: maxLifetimeValidators.vQueryReturns,
  handler: async (ctx, args) => {
    const stored = await storedTtlConfig(ctx);
    // No sign-in or refresh has stored the lifetimes yet, and those are what
    // ping the loop, thus this is only reachable through a manual start.
    if (stored === null) {
      return { kind: "idle" as const };
    }
    const maxLifetimeSeconds = stored.sessionMaxLifetimeSeconds;
    const now = Date.now();
    const expired = await ctx.db
      .query("sessions")
      .withIndex("by_creation_time", (q) =>
        q
          // The bound is inclusive because two rows can share a creation
          // time: the row at the cursor is erased, but a twin of it can stay.
          .gte("_creationTime", args.cursor ?? 0)
          // The boundary matches `refresh`: at exactly the max lifetime, a
          // session is expired. A wake-up at the deadline thus finds work.
          .lte("_creationTime", now - maxLifetimeSeconds * 1000),
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
    // Nothing to erase now. The oldest remaining session is the first one
    // that expires. No session below the cursor stays, thus the same lower
    // bound applies here. `first` reads only up to that row.
    const oldest = await ctx.db
      .query("sessions")
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", args.cursor ?? 0),
      )
      .first();
    if (oldest === null) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.min(
        MAX_SLEEP_MS,
        Math.max(
          0,
          sessionMaxLifetimeExpiresAt(oldest, maxLifetimeSeconds) - Date.now(),
        ),
      ),
    };
  },
});

/**
 * Erase one batch of sessions past the max lifetime.
 *
 * The query ran on a snapshot that takes no read dependencies, thus each
 * session is checked again here. A session that is gone already was erased otherwise. A session that the stored max
 * lifetime no longer expires (it was raised in between) is kept, and the
 * cursor is moved back to it so that a later scan finds it again.
 */
export const deleteSessionsPastMaxLifetime = internalMutation({
  args: maxLifetimeValidators.vMutationArgs,
  returns: maxLifetimeValidators.vMutationReturns,
  handler: async (ctx, { events }) => {
    const stored = await storedTtlConfig(ctx);
    if (stored === null) {
      throw new Error(
        "Invariant violation: the max-lifetime session cleanup loop ran " +
          "with no stored lifetimes",
      );
    }
    const now = Date.now();
    let keptFrom: number | undefined;
    for (const { id } of events) {
      const session = await ctx.db.get("sessions", id);
      if (session === null) continue;
      if (
        sessionMaxLifetimeExpiresAt(session, stored.sessionMaxLifetimeSeconds) >
        now
      ) {
        keptFrom = Math.min(keptFrom ?? Infinity, session._creationTime);
        continue;
      }
      await deleteSession(ctx, session._id);
    }
    return workerResult(events.length, keptFrom);
  },
});
