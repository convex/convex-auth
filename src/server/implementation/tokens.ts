import { GenericId } from "convex/values";
import { ConvexAuthConfig } from "../index.js";
import { SignJWT, importPKCS8 } from "jose";
import { requireEnv } from "../utils.js";
import { TOKEN_SUB_CLAIM_DIVIDER } from "./utils.js";
import { MutationCtx } from "./types.js";

const DEFAULT_JWT_DURATION_MS = 1000 * 60 * 60; // 1 hour

const RESERVED_CLAIMS = new Set(["sub", "iss", "aud", "iat", "exp", "nbf", "jti"]);

export async function generateToken(
  ctx: MutationCtx,
  args: {
    userId: string;
    sessionId: GenericId<"authSessions">;
  },
  config: ConvexAuthConfig,
) {
  const privateKey = await importPKCS8(requireEnv("JWT_PRIVATE_KEY"), "RS256");
  const expirationTime = new Date(
    Date.now() + (config.jwt?.durationMs ?? DEFAULT_JWT_DURATION_MS),
  );

  const extraClaims: Record<string, unknown> = {};
  if (config.jwt?.customClaims) {
    const raw = await config.jwt.customClaims(ctx, {
      userId: args.userId,
      sessionId: args.sessionId,
    });
    for (const [key, value] of Object.entries(raw)) {
      if (RESERVED_CLAIMS.has(key)) {
        throw new Error(`Reserved claim "${key}" in custom claims`);
      }
      extraClaims[key] = value;
    }
  }

  return await new SignJWT({
    ...extraClaims,
    sub: args.userId + TOKEN_SUB_CLAIM_DIVIDER + args.sessionId,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(requireEnv("CONVEX_SITE_URL"))
    .setAudience("convex")
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}
