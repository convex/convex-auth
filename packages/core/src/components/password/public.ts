import { mutation, QueryCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";
import { components } from "./_generated/api.ts";
import { Infer, v } from "convex/values";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import {
  hashPassword,
  verifyPassword as verifyPasswordHash,
} from "argon2id-wasm";
import {
  validatePasswordInputFormat,
  validateNewPassword,
  normalizePassword,
  setPasswordUserError,
  verifyPasswordUserError,
  MIN_PASSWORD_LENGTH,
} from "./validation.ts";

// Throttle for password verification attempts.
//
// This implementation follows Pilcrow’s recommendations (https://auth.pilcrowonpaper.com/passwords).
//
// In particular:
// - The maximum rate is 1 attempt per minute, which caps attackers at ~500k attempts per year.
// - We use a token bucket with a capacity of 5, so that legitimate users
//   shouldn’t be affected by the rate limit in most cases.
// - The rate limit is for each particular user ID. We do not base the rate limits on IP addresses,
//   following recommendations from OWASP, because IP rate limits can hurt legitimate users
//   and can trivially be bypassed by attackers using proxies.
//
// Note that the rate limit can be abused by malicious users to prevent a legitimate user
// from logging in. Applications should allow users to log in through other means,
// for instance through the “reset password” flow, in order to avoid this issue.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  verifyPassword: {
    kind: "token bucket",
    rate: 1,
    period: MINUTE,
    capacity: 5,
  },
});

const setPasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: setPasswordUserError }),
);
type SetPasswordResult = Infer<typeof setPasswordResult>;

/**
 * Set (or replace) a user's password.
 *
 * This can be used both when creating a new user (will create a row),
 * or to update the password for an existing user (will update the existing row).
 *
 * `minimumLength` is the minimum length of the new password. Each caller must
 * set it, so that the caller decides the minimum and does not get the minimum
 * of the component by accident. The password methods give
 * `DEFAULT_MIN_PASSWORD_LENGTH`.
 *
 * @throws If `minimumLength` is less than {@link MIN_PASSWORD_LENGTH}. This is
 * an error of the caller, not of the user.
 */
export const setPassword = mutation({
  args: { userId: v.string(), password: v.string(), minimumLength: v.number() },
  returns: setPasswordResult,
  handler: async (
    ctx,
    { userId, password, minimumLength },
  ): Promise<SetPasswordResult> => {
    const userError = validateNewPassword(password, minimumLength);
    if (userError !== null) {
      return { success: false, userError };
    }

    const passwordHashPHC = await hashPassword(normalizePassword(password));
    const existing = await passwordByUserId(ctx, userId);
    if (existing !== null) {
      await ctx.db.patch("passwords", existing._id, { passwordHashPHC });
    } else {
      await ctx.db.insert("passwords", { userId, passwordHashPHC });
    }

    return { success: true };
  },
});

const verifyPasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: verifyPasswordUserError }),
);
type VerifyPasswordResult = Infer<typeof verifyPasswordResult>;

/**
 * Verify a user's password.
 *
 * This enforces a rate limit (see `rateLimiter` above).
 *
 * In the future, this will also automatically update password hashes
 * that do not match the latest security recommendations.
 */
export const verifyPassword = mutation({
  args: { userId: v.string(), password: v.string() },
  returns: verifyPasswordResult,
  handler: async (ctx, { userId, password }): Promise<VerifyPasswordResult> => {
    const status = await rateLimiter.limit(ctx, "verifyPassword", {
      key: userId,
    });
    if (!status.ok) {
      return {
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: status.retryAfter },
      };
    }

    // We validate the input string before validating the password.
    // This helps us to provide more user-friendly error messages
    // (e.g. we can warn them than the password they’re trying
    // is too short so it can’t be the right one), and is also
    // useful from a security perspective (we avoid resource
    // exhaustion attacks where an attacker makes us compute
    // hashes of really long passwords).
    //
    // Note that if we ever change the default password validation rules,
    // we need to make sure we edit the code so that validation here
    // still accepts older passwords.
    const userError = validatePasswordInputFormat(
      password,
      MIN_PASSWORD_LENGTH,
    );
    if (userError !== null) {
      return { success: false, userError };
    }

    const row = await passwordByUserId(ctx, userId);
    if (row === null) {
      // The app owns the user ↔ userId mapping, so an unknown userId is an
      // unrecoverable programming error rather than a user-facing condition.
      throw new Error(`No password stored for userId ${userId}.`);
    }
    const matches = await verifyPasswordHash(
      normalizePassword(password),
      row.passwordHashPHC,
    );
    if (!matches) {
      return { success: false, userError: { error: "INVALID_CREDENTIALS" } };
    }
    return { success: true };
  },
});

function passwordByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"passwords"> | null> {
  return ctx.db
    .query("passwords")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}
