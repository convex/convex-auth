import { Infer, v } from "convex/values";
import { ActionCtx, Doc, MutationCtx } from "../types.js";
import * as Provider from "../provider.js";
import { ConvexCredentialsConfig } from "../../types.js";
import { upsertUserAndAccount } from "../users.js";
import { getAuthSessionId } from "../sessions.js";
import { LOG_LEVELS, logWithLevel, maybeRedact } from "../utils.js";

export const createAccountFromCredentialsArgs = v.object({
  provider: v.string(),
  account: v.object({ id: v.string(), secret: v.optional(v.string()) }),
  profile: v.any(),
  shouldLinkViaEmail: v.optional(v.boolean()),
  shouldLinkViaPhone: v.optional(v.boolean()),
});

type ReturnType = {
  account: Doc<"authAccounts">;
};

export async function createAccountFromCredentialsImpl(
  ctx: MutationCtx,
  args: Infer<typeof createAccountFromCredentialsArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<ReturnType> {
  logWithLevel(LOG_LEVELS.DEBUG, "createAccountFromCredentialsImpl args:", {
    provider: args.provider,
    account: {
      id: args.account.id,
      secret: maybeRedact(args.account.secret ?? ""),
    },
  });
  const {
    provider: providerId,
    account,
    profile,
    shouldLinkViaEmail,
    shouldLinkViaPhone,
  } = args;
  const provider = getProviderOrThrow(providerId) as ConvexCredentialsConfig;
  const existingAccount = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", provider.id).eq("providerAccountId", account.id),
    )
    .unique();
  if (existingAccount !== null) {
    if (
      account.secret !== undefined &&
      !(await Provider.verify(
        provider,
        account.secret,
        existingAccount.secret ?? "",
      ))
    ) {
      throw new Error(`Account ${account.id} already exists`);
    }
    return {
      account: existingAccount,
    };
  }

  const secret =
    account.secret !== undefined
      ? await Provider.hash(provider, account.secret)
      : undefined;
  const { accountId } = await upsertUserAndAccount(
    ctx,
    await getAuthSessionId(ctx),
    { providerAccountId: account.id, secret },
    {
      type: "credentials",
      provider,
      profile,
      shouldLinkViaEmail,
      shouldLinkViaPhone,
    },
    config,
  );

  return {
    account: (await ctx.db.get(accountId))!,
  };
}

export const callCreateAccountFromCredentials = async (
  ctx: ActionCtx,
  args: Infer<typeof createAccountFromCredentialsArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "createAccountFromCredentials",
      ...args,
    },
  });
};
