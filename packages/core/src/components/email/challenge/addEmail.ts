// The `addEmail` challenge: prove that an address belongs to `userId`, then
// record it as an email address of the user. The first address of a user
// becomes primary; a later address is secondary.

import { Infer, v } from "convex/values";
import { verifyCurrentUser } from "../../custom.ts";
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
 * Start an `addEmail` challenge for the signed-in user. `currentUser` is the
 * current-user attestation of the core (`attestCurrentUser`). Fails with
 * `EMAIL_TAKEN` when a user has already verified the address.
 */
export const start = mutation({
  args: { ...vStartArgs, currentUser: v.string() },
  returns: startFreeAddressResult,
  handler: async (ctx, args): Promise<StartFreeAddressResult> => {
    const { userId } = await verifyCurrentUser(args.currentUser);
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
      purpose: { kind: "addEmail", userId },
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
  completeCallerAddressFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete an `addEmail` challenge: record the address for the user.
 * `currentUser` is the current-user attestation of the core
 * (`attestCurrentUser`). The signed-in user must be the one of the start;
 * another user fails with
 * `WRONG_USER`, and the challenge stays. Fails with `EMAIL_TAKEN` when
 * another user verified the address after the start.
 */
export const complete = mutation({
  args: { ...vClaimArgs, currentUser: v.string() },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const { userId } = await verifyCurrentUser(args.currentUser);
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: { kind: "addEmail", userId },
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
    // The first address of a user always becomes primary.
    const isPrimary = !(await userHasEmail(ctx, userId));
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary,
    });
    return { success: true, userId, email: row.email };
  },
});
