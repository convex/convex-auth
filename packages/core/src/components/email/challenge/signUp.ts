// The `signUp` challenge: prove that an address belongs to a new user, then
// record it as the primary email address of the user. The user has no
// session yet, thus `complete` does not take a `userId`: the user is the one
// given at start.

import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import {
  ADD_EMAIL_TTL_MS,
  VALIDATE_EMAIL_COPY,
  userHasEmail,
} from "../helpers.ts";
import { normalizeEmail, startFreeAddressUserError } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startFreeAddressResult,
  completeFreeAddressFailure,
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
 * Start a `signUp` challenge for `userId`, a user that the sign-up has just
 * created. Fails with `EMAIL_TAKEN` when a user has already verified the
 * address.
 *
 * Throws when the user already has an email address: it is an application
 * bug. Give only a user that the same mutation has just created.
 *
 * DANGER: `complete` records the address on this `userId` with no further
 * check, thus an unverified `userId` lets an attacker attach their mailbox
 * to another user's account.
 *
 * TODO: ensure that the user ID is a user that the current mutation has just
 * created.
 */
export const _internal_dangerous_start = mutation({
  args: { ...vStartArgs, userId: v.string() },
  returns: startFreeAddressResult,
  handler: async (ctx, args): Promise<StartFreeAddressResult> => {
    if (await userHasEmail(ctx, args.userId)) {
      throw new Error(
        "Cannot start a signUp challenge: the user already has an email " +
          "address. Use addEmail or changeEmail for an existing user.",
      );
    }
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
      purpose: { kind: "signUp", userId: args.userId },
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
  }),
  completeFreeAddressFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `signUp` challenge: record the address for the user that the
 * challenge was started for, and return that user.
 *
 * Fails with `EMAIL_TAKEN` when another user verified the address after the start.
 *
 * Fails with `INVALID_CHALLENGE` when the user already has an email address.
 * This happens when the app started more than one `signUp` challenge for the
 * user, and another one completed first: the sign-up is done, thus this link
 * is no longer valid. (This doesn’t happen when using the official email setup
 * functions, but it can happen if the user manually implements an auth flow
 * on top this challenge flow.)
 */
export const complete = mutation({
  args: vClaimArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: { kind: "signUp" },
    });
    if (!claim.success) {
      return claim.failure;
    }
    const { row } = claim;
    const { userId } = row.purpose;
    // Before `EMAIL_TAKEN`: when the other challenge was for the same address,
    // this user is the one who took it.
    if (await userHasEmail(ctx, userId)) {
      console.warn(
        `Rejected the email challenge ${row._id} for the purpose "signUp": ` +
          `the user already has an email address, most likely from another ` +
          `signUp challenge for the user that completed first.`,
      );
      return {
        success: false,
        userError: { error: "INVALID_CHALLENGE" },
      };
    }
    const normalizedEmail = normalizeEmail(row.email);
    const taken = await addressTakenError(ctx, normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: taken };
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary: true,
    });
    return { success: true, userId, email: row.email };
  },
});
