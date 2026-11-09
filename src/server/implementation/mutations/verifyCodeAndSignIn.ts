import { GenericId, Infer, v } from "convex/values";
import { ActionCtx, MutationCtx, SessionInfo } from "../types.js";
import {
  isSignInRateLimited,
  recordFailedSignIn,
  resetSignInRateLimit,
} from "../rateLimit.js";
import * as Provider from "../provider.js";
import {
  createNewAndDeleteExistingSession,
  getAuthSessionId,
  maybeGenerateTokensForSession,
} from "../sessions.js";
import { ConvexAuthConfig } from "../../types.js";
import { LOG_LEVELS, logWithLevel, sha256 } from "../utils.js";
import { upsertUserAndAccount } from "../users.js";

export const verifyCodeAndSignInArgs = v.object({
  params: v.any(),
  provider: v.optional(v.string()),
  verifier: v.optional(v.string()),
  accountId: v.optional(v.id("authAccounts")),
  generateTokens: v.boolean(),
  allowExtraProviders: v.boolean(),
});

type ReturnType = null | SessionInfo;

const MIN_HIGH_ENTROPY_CODE_LENGTH = 20;

export async function verifyCodeAndSignInImpl(
  ctx: MutationCtx,
  args: Infer<typeof verifyCodeAndSignInArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<ReturnType> {
  logWithLevel(LOG_LEVELS.DEBUG, "verifyCodeAndSignInImpl args:", {
    params: { email: args.params.email, phone: args.params.phone },
    provider: args.provider,
    verifier: args.verifier,
    generateTokens: args.generateTokens,
    allowExtraProviders: args.allowExtraProviders,
  });
  const { generateTokens, provider, allowExtraProviders } = args;
  const identifier = args.params.email ?? args.params.phone;
  if (identifier !== undefined) {
    if (await isSignInRateLimited(ctx, identifier, config)) {
      // Rate limit tripped. Expected protective behavior, but worth surfacing as a
      // potential abuse signal.
      logWithLevel(
        LOG_LEVELS.WARN,
        "Too many failed attempts to verify code for this email",
      );
      return null;
    }
  }
  const verifyResult = await verifyCodeOnly(
    ctx,
    args,
    provider ?? null,
    getProviderOrThrow,
    allowExtraProviders,
    config,
    await getAuthSessionId(ctx),
  );
  if (verifyResult === null) {
    if (identifier !== undefined) {
      await recordFailedSignIn(ctx, identifier, config);
    }
    return null;
  }
  if (identifier !== undefined) {
    await resetSignInRateLimit(ctx, identifier);
  }
  const { userId } = verifyResult;
  const sessionId = await createNewAndDeleteExistingSession(
    ctx,
    config,
    userId,
  );
  return await maybeGenerateTokensForSession(
    ctx,
    config,
    userId,
    sessionId,
    generateTokens,
  );
}

export const callVerifyCodeAndSignIn = async (
  ctx: ActionCtx,
  args: Infer<typeof verifyCodeAndSignInArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "verifyCodeAndSignIn",
      ...args,
    },
  });
};

async function verifyCodeOnly(
  ctx: MutationCtx,
  args: {
    params: any;
    verifier?: string;
    identifier?: string;
    accountId?: GenericId<"authAccounts">;
  },
  /**
   * There are two providers at play:
   * 1. the provider that generated the code
   * 2. the provider the account is tied to.
   * This is because we allow signing into an account
   * via another provider, see {@link signInViaProvider}.
   * This is the first provider.
   */
  methodProviderId: string | null,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  allowExtraProviders: boolean,
  config: ConvexAuthConfig,
  sessionId: GenericId<"authSessions"> | null,
) {
  const { params, verifier } = args;
  const identifier = params.email ?? params.phone;
  const codeHash = await sha256(params.code);
  const verificationCode = await ctx.db
    .query("authVerificationCodes")
    .withIndex("code", (q) => q.eq("code", codeHash))
    .unique();
  if (verificationCode === null) {
    // Expected: user supplied a wrong/already-consumed code, or reused a magic link.
    // Normal sign-in failure, not a server error.
    logWithLevel(LOG_LEVELS.INFO, "Invalid verification code");
    return null;
  }
  if (verificationCode.verifier !== verifier) {
    // Expected: e.g. a magic link opened in a different browser than it was requested
    // from. Normal sign-in failure.
    logWithLevel(LOG_LEVELS.INFO, "Invalid verifier");
    return null;
  }
  if (verificationCode.expirationTime < Date.now()) {
    // Expected: the user took too long, or followed a stale magic link.
    logWithLevel(LOG_LEVELS.INFO, "Expired verification code");
    await ctx.db.delete(verificationCode._id);
    return null;
  }
  if (
    args.accountId === undefined &&
    identifier === undefined &&
    verificationCode.verifier === undefined &&
    params.code.length < MIN_HIGH_ENTROPY_CODE_LENGTH
  ) {
    logWithLevel(
      LOG_LEVELS.ERROR,
      `Low-entropy verification code used for provider "${verificationCode.provider}". ` +
        "Modify its `generateVerificationToken` to generate codes with more entropy.",
    );
    return null;
  }
  const { accountId, emailVerified, phoneVerified } = verificationCode;
  const account = await ctx.db.get(accountId);
  if (account === null) {
    // Unusual: the account was deleted between code issuance and redemption.
    logWithLevel(
      LOG_LEVELS.WARN,
      "Account associated with this email has been deleted",
    );
    return null;
  }
  if (args.accountId !== undefined && args.accountId !== accountId) {
    return null;
  }
  if (
    args.accountId === undefined &&
    identifier !== undefined &&
    account.providerAccountId !== identifier
  ) {
    return null;
  }
  if (
    methodProviderId !== null &&
    verificationCode.provider !== methodProviderId
  ) {
    // Unusual: client redeemed a code against a different provider than issued it.
    logWithLevel(
      LOG_LEVELS.WARN,
      `Invalid provider "${methodProviderId}" for given \`code\`, ` +
        `which was generated by provider "${verificationCode.provider}"`,
    );
    return null;
  }
  const methodProvider = Provider.getProviderOrNull(
    getProviderOrThrow,
    verificationCode.provider,
    allowExtraProviders,
  );
  if (methodProvider === null) {
    logWithLevel(
      LOG_LEVELS.WARN,
      `Provider "${verificationCode.provider}" which generated this \`code\` ` +
        `is not available here`,
    );
    return null;
  }

  if (
    (methodProvider.type === "email" || methodProvider.type === "phone") &&
    methodProvider.authorize !== undefined
  ) {
    try {
      await methodProvider.authorize(args.params, account);
    } catch (error) {
      logWithLevel(
        LOG_LEVELS.WARN,
        "Verification code failed the provider's `authorize` check",
        error,
      );
      return null;
    }
  }
  const provider = Provider.getProviderOrNull(
    getProviderOrThrow,
    account.provider,
  );
  if (provider === null) {
    logWithLevel(
      LOG_LEVELS.WARN,
      `Provider "${account.provider}" for this account is not configured`,
    );
    return null;
  }
  // Every check passed, so consume the code.
  await ctx.db.delete(verificationCode._id);
  let userId = account.userId;
  if (!(provider.type === "oauth" || provider.type === "oidc")) {
    ({ userId } = await upsertUserAndAccount(
      ctx,
      sessionId,
      { existingAccount: account },
      {
        type: "verification",
        provider,
        profile: {
          ...(emailVerified !== undefined
            ? { email: emailVerified, emailVerified: true }
            : {}),
          ...(phoneVerified !== undefined
            ? { phone: phoneVerified, phoneVerified: true }
            : {}),
        },
      },
      config,
    ));
  }

  return { providerAccountId: account.providerAccountId, userId };
}
