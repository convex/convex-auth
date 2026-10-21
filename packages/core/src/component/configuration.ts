import type { QueryCtx } from "./_generated/server.ts";

export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}): TtlConfig {
  const accessTokenTtlSeconds = args.accessTokenTtlSeconds ?? 60;
  const refreshTokenTtlSeconds =
    args.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;
  if (
    !Number.isFinite(accessTokenTtlSeconds) ||
    !Number.isFinite(refreshTokenTtlSeconds) ||
    accessTokenTtlSeconds <= 0 ||
    refreshTokenTtlSeconds <= 0
  ) {
    throw new Error("Token TTLs must be positive.");
  }
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh-token TTL.",
    );
  }
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}

export async function getConfiguration(ctx: QueryCtx) {
  return await ctx.db.query("configuration").unique();
}

export async function getProvider(ctx: QueryCtx, name: string) {
  const config = await getConfiguration(ctx);
  const provider = config?.providers?.find(
    (provider) => provider.name === name,
  );
  if (provider === undefined) {
    throw new Error(
      `Auth provider "${name}" is not configured. Register it in convex.config.ts.`,
    );
  }
  return provider;
}
