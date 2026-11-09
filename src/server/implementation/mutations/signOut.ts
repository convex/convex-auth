import { GenericId } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import { deleteSession, getAuthSessionId } from "../sessions.js";

type ReturnType = {
  userId: string;
  sessionId: GenericId<"authSessions">;
} | null;

export async function signOutImpl(ctx: MutationCtx): Promise<ReturnType> {
  const sessionId = await getAuthSessionId(ctx);
  if (sessionId !== null) {
    const session = await ctx.db.get(sessionId);
    if (session !== null) {
      await deleteSession(ctx, session);
      return { userId: session.userId, sessionId: session._id };
    }
  }
  return null;
}

export const callSignOut = async (ctx: ActionCtx): Promise<void> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "signOut",
    },
  });
};
