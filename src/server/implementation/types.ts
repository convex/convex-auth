import {
  DataModelFromSchemaDefinition,
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  TableNamesInDataModel,
  defineSchema,
  defineTable,
} from "convex/server";
import { GenericId, v } from "convex/values";
import { GenericDoc } from "../convex_types.js";

/**
 * The table definitions required by the library.
 *
 * Your schema must include these so that the indexes
 * are set up:
 *
 *
 * ```ts filename="convex/schema.ts"
 * import { defineSchema } from "convex/server";
 * import { authTables } from "@convex-dev/auth/server";
 *
 * const schema = defineSchema({
 *   ...authTables,
 * });
 *
 * export default schema;
 * ```
 *
 * You can inline the table definitions into your schema
 * and extend them with additional optional and required
 * fields. See https://labs.convex.dev/auth/setup/schema
 * for more details.
 */
export const authTables = {
  /**
   * Users.
   */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),
  /**
   * Sessions.
   * A single user can have multiple active sessions.
   * See [Session document lifecycle](https://labs.convex.dev/auth/advanced#session-document-lifecycle).
   */
  authSessions: defineTable({
    userId: v.string(),
    expirationTime: v.number(),
  }).index("userId", ["userId"]),
  /**
   * Accounts. An account corresponds to
   * a single authentication provider.
   * A single user can have multiple accounts linked.
   */
  authAccounts: defineTable({
    userId: v.string(),
    provider: v.string(),
    providerAccountId: v.string(),
    secret: v.optional(v.string()),
    emailVerified: v.optional(v.string()),
    phoneVerified: v.optional(v.string()),
  })
    .index("userIdAndProvider", ["userId", "provider"])
    .index("providerAndAccountId", ["provider", "providerAccountId"]),
  /**
   * Refresh tokens.
   * Refresh tokens are generally meant to be used once, to be exchanged for another
   * refresh token and a JWT access token, but with a few exceptions:
   * - The "active refresh token" is the most recently created refresh token that has
   *   not been used yet. The parent of the active refresh token can always be used to
   *   obtain the active refresh token.
   * - A refresh token can be used within a 10 second window ("reuse window") to
   *   obtain a new refresh token.
   * - On any invalid use of a refresh token, the token itself and all its descendants
   *   are invalidated.
   */
  authRefreshTokens: defineTable({
    sessionId: v.id("authSessions"),
    expirationTime: v.number(),
    firstUsedTime: v.optional(v.number()),
    // This is the ID of the refresh token that was exchanged to create this one.
    parentRefreshTokenId: v.optional(v.id("authRefreshTokens")),
  })
    // Sort by creationTime
    .index("sessionId", ["sessionId"])
    .index("sessionIdAndParentRefreshTokenId", [
      "sessionId",
      "parentRefreshTokenId",
    ]),
  /**
   * Verification codes:
   * - OTP tokens
   * - magic link tokens
   * - OAuth codes
   */
  authVerificationCodes: defineTable({
    accountId: v.id("authAccounts"),
    provider: v.string(),
    code: v.string(),
    expirationTime: v.number(),
    verifier: v.optional(v.string()),
    emailVerified: v.optional(v.string()),
    phoneVerified: v.optional(v.string()),
  })
    .index("accountId", ["accountId"])
    .index("code", ["code"]),
  /**
   * PKCE verifiers for OAuth.
   */
  authVerifiers: defineTable({
    sessionId: v.optional(v.id("authSessions")),
    signature: v.optional(v.string()),
  }).index("signature", ["signature"]),
  /**
   * Rate limits for OTP and password sign-in.
   */
  authRateLimits: defineTable({
    identifier: v.string(),
    lastAttemptTime: v.number(),
    attemptsLeft: v.number(),
  }).index("identifier", ["identifier"]),
};

const defaultSchema = defineSchema(authTables);

export type AuthDataModel = DataModelFromSchemaDefinition<typeof defaultSchema>;
export type ActionCtx = GenericActionCtx<AuthDataModel>;
export type MutationCtx = GenericMutationCtx<AuthDataModel>;
export type QueryCtx = GenericQueryCtx<AuthDataModel>;
export type Doc<T extends TableNamesInDataModel<AuthDataModel>> = GenericDoc<
  AuthDataModel,
  T
>;

export type Tokens = { token: string; refreshToken: string };
export type SessionInfo = {
  userId: string;
  sessionId: GenericId<"authSessions">;
  tokens: Tokens | null;
};
export type SessionInfoWithTokens = {
  userId: string;
  sessionId: GenericId<"authSessions">;
  tokens: Tokens;
};
