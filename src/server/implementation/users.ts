import { GenericId } from "convex/values";
import { Doc, MutationCtx, QueryCtx } from "./types.js";
import { AuthProviderMaterializedConfig, ConvexAuthConfig } from "../types.js";
import { LOG_LEVELS, logWithLevel } from "./utils.js";

type CreateOrUpdateUserArgs = {
  type: "oauth" | "credentials" | "email" | "phone" | "verification";
  provider: AuthProviderMaterializedConfig;
  profile: Record<string, unknown> & {
    email?: string;
    phone?: string;
    emailVerified?: boolean;
    phoneVerified?: boolean;
  };
  shouldLinkViaEmail?: boolean;
  shouldLinkViaPhone?: boolean;
};

export async function upsertUserAndAccount(
  ctx: MutationCtx,
  sessionId: GenericId<"authSessions"> | null,
  account:
    | { existingAccount: Doc<"authAccounts"> }
    | {
        providerAccountId: string;
        secret?: string;
      },
  args: CreateOrUpdateUserArgs,
  config: ConvexAuthConfig,
): Promise<{
  userId: string;
  accountId: GenericId<"authAccounts">;
}> {
  const userId = await defaultCreateOrUpdateUser(
    ctx,
    sessionId,
    "existingAccount" in account ? account.existingAccount : null,
    args,
    config,
  );
  const accountId = await createOrUpdateAccount(ctx, userId, account, args);
  return { userId, accountId };
}

async function defaultCreateOrUpdateUser(
  ctx: MutationCtx,
  existingSessionId: GenericId<"authSessions"> | null,
  existingAccount: Doc<"authAccounts"> | null,
  args: CreateOrUpdateUserArgs,
  config: ConvexAuthConfig,
) {
  logWithLevel(LOG_LEVELS.DEBUG, "defaultCreateOrUpdateUser args:", {
    existingAccountId: existingAccount?._id,
    existingSessionId,
    args: { ...args, provider: args.provider.id },
  });
  const existingUserId = (existingAccount?.userId ??
    null) as GenericId<"users"> | null;
  if (config.callbacks?.createOrUpdateUser !== undefined) {
    logWithLevel(LOG_LEVELS.DEBUG, "Using custom createOrUpdateUser callback");
    return await config.callbacks.createOrUpdateUser(ctx, {
      existingUserId,
      ...args,
    });
  } else {
    if (
      existingUserId &&
      ctx.db.normalizeId("users", existingUserId) === null
    ) {
      throw new Error(
        `User ID \`${existingUserId}\` is not in the \`users\` table`,
      );
    }
  }

  const {
    provider,
    profile: {
      emailVerified: profileEmailVerified,
      phoneVerified: profilePhoneVerified,
      ...profile
    },
  } = args;
  const emailVerified =
    profileEmailVerified ??
    ((provider.type === "oauth" || provider.type === "oidc") &&
      provider.allowDangerousEmailAccountLinking !== false);
  const phoneVerified = profilePhoneVerified ?? false;
  const shouldLinkViaEmail =
    args.shouldLinkViaEmail || emailVerified || provider.type === "email";
  const shouldLinkViaPhone =
    args.shouldLinkViaPhone || phoneVerified || provider.type === "phone";

  let userId = existingUserId;
  if (existingUserId === null) {
    const existingUserWithVerifiedEmailId =
      typeof profile.email === "string" && shouldLinkViaEmail
        ? (await uniqueUserWithVerifiedEmail(ctx, profile.email))?._id ?? null
        : null;

    const existingUserWithVerifiedPhoneId =
      typeof profile.phone === "string" && shouldLinkViaPhone
        ? (await uniqueUserWithVerifiedPhone(ctx, profile.phone))?._id ?? null
        : null;
    // If there is both email and phone verified user
    // already we can't link.
    if (
      existingUserWithVerifiedEmailId !== null &&
      existingUserWithVerifiedPhoneId !== null
    ) {
      logWithLevel(
        LOG_LEVELS.DEBUG,
        `Found existing email and phone verified users, so not linking: email: ${existingUserWithVerifiedEmailId}, phone: ${existingUserWithVerifiedPhoneId}`,
      );
      userId = null;
    } else if (existingUserWithVerifiedEmailId !== null) {
      logWithLevel(
        LOG_LEVELS.DEBUG,
        `Found existing email verified user, linking: ${existingUserWithVerifiedEmailId}`,
      );
      userId = existingUserWithVerifiedEmailId;
    } else if (existingUserWithVerifiedPhoneId !== null) {
      logWithLevel(
        LOG_LEVELS.DEBUG,
        `Found existing phone verified user, linking: ${existingUserWithVerifiedPhoneId}`,
      );
      userId = existingUserWithVerifiedPhoneId;
    } else {
      logWithLevel(
        LOG_LEVELS.DEBUG,
        "No existing verified users found, creating new user",
      );
      userId = null;
    }
  }
  const userData = {
    ...(emailVerified ? { emailVerificationTime: Date.now() } : null),
    ...(phoneVerified ? { phoneVerificationTime: Date.now() } : null),
    ...profile,
  };
  const existingOrLinkedUserId = userId;
  if (userId !== null) {
    try {
      await ctx.db.patch(userId, userData);
    } catch (error) {
      throw new Error(
        `Could not update user document with ID \`${userId}\`, ` +
          `either the user has been deleted but their account has not, ` +
          `or the profile data doesn't match the \`users\` table schema: ` +
          `${(error as Error).message}`,
      );
    }
  } else {
    userId = await ctx.db.insert("users", userData);
  }
  const afterUserCreatedOrUpdated = config.callbacks?.afterUserCreatedOrUpdated;
  if (afterUserCreatedOrUpdated !== undefined) {
    logWithLevel(
      LOG_LEVELS.DEBUG,
      "Calling custom afterUserCreatedOrUpdated callback",
    );
    await afterUserCreatedOrUpdated(ctx, {
      userId,
      existingUserId: existingOrLinkedUserId,
      ...args,
    });
  } else {
    logWithLevel(
      LOG_LEVELS.DEBUG,
      "No custom afterUserCreatedOrUpdated callback, skipping",
    );
  }
  return userId;
}

async function uniqueUserWithVerifiedEmail(ctx: QueryCtx, email: string) {
  const users = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .filter((q) => q.neq(q.field("emailVerificationTime"), undefined))
    .take(2);
  return users.length === 1 ? users[0] : null;
}

async function uniqueUserWithVerifiedPhone(ctx: QueryCtx, phone: string) {
  const users = await ctx.db
    .query("users")
    .withIndex("phone", (q) => q.eq("phone", phone))
    .filter((q) => q.neq(q.field("phoneVerificationTime"), undefined))
    .take(2);
  return users.length === 1 ? users[0] : null;
}

async function createOrUpdateAccount(
  ctx: MutationCtx,
  userId: string,
  account:
    | { existingAccount: Doc<"authAccounts"> }
    | {
        providerAccountId: string;
        secret?: string;
      },
  args: CreateOrUpdateUserArgs,
) {
  const accountId =
    "existingAccount" in account
      ? account.existingAccount._id
      : await ctx.db.insert("authAccounts", {
          userId,
          provider: args.provider.id,
          providerAccountId: account.providerAccountId,
          secret: account.secret,
        });
  // This is never used with the default `createOrUpdateUser` implementation,
  // but it is used for manual linking via custom `createOrUpdateUser`:
  if (
    "existingAccount" in account &&
    account.existingAccount.userId !== userId
  ) {
    await ctx.db.patch(accountId, { userId });
  }
  if (args.profile.emailVerified) {
    await ctx.db.patch(accountId, { emailVerified: args.profile.email });
  }
  if (args.profile.phoneVerified) {
    await ctx.db.patch(accountId, { phoneVerified: args.profile.phone });
  }
  return accountId;
}

export async function getAccountOrThrow(
  ctx: QueryCtx,
  existingAccountId: GenericId<"authAccounts">,
) {
  const existingAccount = await ctx.db.get(existingAccountId);
  if (existingAccount === null) {
    throw new Error(
      `Expected an account to exist for ID "${existingAccountId}"`,
    );
  }
  return existingAccount;
}
