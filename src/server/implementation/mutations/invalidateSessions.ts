import { Infer, v } from "convex/values";
import { deleteSession } from "../sessions.js";
import { ActionCtx, MutationCtx } from "../types.js";
import { LOG_LEVELS, logWithLevel } from "../utils.js";

export const invalidateSessionsArgs = v.object({
  userId: v.string(),
  except: v.optional(v.array(v.id("authSessions"))),
});

export const callInvalidateSessions = async (
  ctx: ActionCtx,
  args: Infer<typeof invalidateSessionsArgs>,
): Promise<void> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "invalidateSessions",
      ...args,
    },
  });
};

export const invalidateSessionsImpl = async (
  ctx: MutationCtx,
  args: Infer<typeof invalidateSessionsArgs>,
): Promise<void> => {
  logWithLevel(LOG_LEVELS.DEBUG, "invalidateSessionsImpl args:", args);
  const { userId, except } = args;
  const exceptSet = new Set(except ?? []);
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    if (!exceptSet.has(session._id)) {
      await deleteSession(ctx, session);
    }
  }
  return;
};
