// The `changeEmail` challenge: prove that an address belongs to
// `userId`, then make it the primary address of the user. The previous
// primary address is removed from the account. For apps where each user has
// one email address.

import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import { ADD_EMAIL_TTL_MS, VALIDATE_EMAIL_COPY } from "../helpers.ts";
import { normalizeEmail, startFreeAddressUserError } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startFreeAddressResult,
  completeCallerAddressFailure,
  startFreeAddressPreconditions,
  addressTakenError,
  createChallengeAndSendEmail,
  claimChallenge,
  type StartFreeAddressResult,
} from "./common.ts";

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * typically without consuming the rate limits. See `custom.check`.
 *
 * One exception: `EMAIL_TAKEN` takes a token from the `lookupEmailPerIp`
 * limit, because it tells the caller that the address has an account. See
 * `startFreeAddressPreconditions`.
 */
export const check = mutation({
  args: { email: v.string() },
  returns: v.union(startFreeAddressUserError, v.null()),
  handler: (ctx, { email }) =>
    startFreeAddressPreconditions(ctx, email, "check"),
});

/**
 * Start a `changeEmail` challenge for `userId`. Fails with `EMAIL_TAKEN`
 * when a user has already verified the address.
 *
 * DANGER: `complete` records the address on this `userId`, thus an
 * unverified `userId` lets an attacker attach their mailbox to another
 * user's account.
 *
 * TODO: ensure that the user ID is the current user.
 */
export const _internal_dangerous_start = mutation({
  args: { ...vStartArgs, userId: v.string() },
  returns: startFreeAddressResult,
  handler: async (ctx, args): Promise<StartFreeAddressResult> => {
    const error = await startFreeAddressPreconditions(
      ctx,
      args.email,
      "consume",
    );
    if (error !== null) {
      return { success: false, userError: error };
    }
    const created = await createChallengeAndSendEmail(ctx, {
      email: args.email,
      purpose: { kind: "changeEmail", userId: args.userId },
      ttlMs: ADD_EMAIL_TTL_MS,
      url: args.url,
      emailSender: args.emailSender,
      copy: VALIDATE_EMAIL_COPY,
    });
    return { success: true, ...created };
  },
});

const completeResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    email: v.string(),
    // The address that was primary before this completion replaced it, or
    // `null` when there was none. Callers use it to notify the old address.
    previousEmail: v.union(v.string(), v.null()),
  }),
  completeCallerAddressFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `changeEmail` challenge: remove the old primary address and
 * record the new one as primary. The `userId` must be the one given at
 * start; another user fails with `WRONG_USER`, and
 * the challenge stays.
 *
 * This can fail with `EMAIL_TAKEN` in the very rare case where the email is
 * assigned to someone else on verification. This can happen in the following scenario:
 * - Alice starts an email change flow for `new@example.com`. At this point,
 *   `new@example.com` is assigned to nobody, so the flow is allowed to start.
 * - Bob also starts an email change flow for `new@example.com`.
 * - Bob completes the flow, and is assigned `new@example.com`.
 * - Alice attempts to complete the flow too, but at this point the email
 *   is no longer available, so the completion fails with `EMAIL_TAKEN`.
 */
export const complete = mutation({
  args: { ...vClaimArgs, userId: v.string() },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const { userId } = args;
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: { kind: "changeEmail", userId },
    });
    if (!claim.success) {
      return claim.failure;
    }
    const { row } = claim;
    const normalizedEmail = normalizeEmail(row.email);
    const taken = await addressTakenError(ctx, normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: taken };
    }
    // For a first email there is nothing to replace; for a change-email flow
    // the old address is removed from the account.
    const oldPrimary = await ctx.db
      .query("verifiedEmails")
      .withIndex("by_userId_isPrimary", (q) =>
        q.eq("userId", userId).eq("isPrimary", true),
      )
      .unique();
    let previousEmail: string | null = null;
    if (oldPrimary !== null) {
      previousEmail = oldPrimary.email;
      await ctx.db.delete("verifiedEmails", oldPrimary._id);
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary: true,
    });
    return {
      success: true,
      userId,
      email: row.email,
      previousEmail,
    };
  },
});
