import { Infer, v } from "convex/values";
import { ActionCtx, MutationCtx, SessionInfo } from "../types.js";
import * as Provider from "../provider.js";
import {
  createNewAndDeleteExistingSession,
  maybeGenerateTokensForSession,
} from "../sessions.js";
import { LOG_LEVELS, logWithLevel } from "../utils.js";

export const signInArgs = v.object({
  userId: v.string(),
  sessionId: v.optional(v.id("authSessions")),
  generateTokens: v.boolean(),
});

type ReturnType = SessionInfo;

export async function signInImpl(
  ctx: MutationCtx,
  args: Infer<typeof signInArgs>,
  config: Provider.Config,
): Promise<ReturnType> {
  logWithLevel(LOG_LEVELS.DEBUG, "signInImpl args:", args);
  const { userId, sessionId: existingSessionId, generateTokens } = args;
  const sessionId =
    existingSessionId ??
    (await createNewAndDeleteExistingSession(ctx, config, userId));
  return await maybeGenerateTokensForSession(
    ctx,
    config,
    userId,
    sessionId,
    generateTokens,
  );
}

export const callSignIn = async (
  ctx: ActionCtx,
  args: Infer<typeof signInArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "signIn",
      ...args,
    },
  });
};
