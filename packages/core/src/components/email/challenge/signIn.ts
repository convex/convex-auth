// The `signIn` challenge: sign in with a short code sent by email, with no
// password. The person proves that they control the address, and the
// completion gives the user that owns it. When no user owns the address, the
// sign-in method creates a user, and `_internal_dangerous_completeForNewUser`
// records the address as its primary email address.
//
// The email carries a short code that the person types where they started,
// not a link. A link opens in the browser that the mail app picks, which is
// often not the one that started the flow: an installed web app, the browser
// inside a mail app, a native app, or another device.
//
// The completion is in two steps, because the method creates the user
// between them when the address has no owner. All of the steps run in the
// one mutation of the method:
//
// ```
//  Client                   Method                                      Component
//    │                        │                                            │
//    │  the code + secret     │                                            │
//    ├───────────────────────▶│                                            │
//    │                        │  verifyCode                                │
//    │                        ├───────────────────────────────────────────▶│     verify the code, count a wrong one
//    │                        │◀───────────────────────────────────────────┤     the owner of the address, or null
//    │                        │                                            │
//    │                        │  an owner: complete                        │
//    │                        ├───────────────────────────────────────────▶│     delete the row
//    │                        │                                            │
//    │                        │  no owner: create the user, then           │
//    │                        │  _internal_dangerous_completeForNewUser    │
//    │                        ├───────────────────────────────────────────▶│     delete the row, record the address
//    │◀───────────────────────┤                                            │
//    │                        │                                            │
// ```

import { Infer, v } from "convex/values";
import { mutation, type MutationCtx } from "../_generated/server.ts";
import {
  SIGN_IN_CODE_LENGTH_DEFAULT,
  SIGN_IN_CODE_LENGTH_MAX,
  SIGN_IN_CODE_LENGTH_MIN,
  SIGN_IN_COPY,
  SIGN_IN_TTL_DEFAULT_MS,
  SIGN_IN_TTL_MAX_MS,
  SIGN_IN_TTL_MIN_MS,
  emailByNormalizedEmail,
  userHasEmail,
} from "../helpers.ts";
import {
  completeCodeChallengeUserError,
  normalizeEmail,
  vEmailSenderConfig,
} from "../validation.ts";
import {
  startChallengeResult,
  startPreconditions,
  createCodeChallengeAndSendEmail,
  verifyCodeChallenge,
  claimCodeChallenge,
  type StartChallengeResult,
} from "./common.ts";

const PURPOSE = { kind: "signIn" } as const;

/**
 * Start a `signIn` challenge: send a short code to the address.
 *
 * The result is the same whether or not a user owns the address, thus it does
 * not tell the caller if the address has an account. When a user owns the
 * address, the code goes to the address as the user verified it, which can
 * differ from `email` in case or in Unicode form: a mail server can treat
 * `Alice@` and `alice@` as two mailboxes.
 *
 * `codeLength` is the number of digits of the code, between
 * `SIGN_IN_CODE_LENGTH_MIN` and `SIGN_IN_CODE_LENGTH_MAX`. `ttlMs` bounds how
 * long the code works, between `SIGN_IN_TTL_MIN_MS` and `SIGN_IN_TTL_MAX_MS`.
 * A value outside these bounds is a programming error and throws.
 *
 * `subject` and `intro` are the first lines of the email; `{code}` in the
 * subject is replaced by the code. The component appends the code and the
 * expiry to the intro.
 */
export const start = mutation({
  args: {
    email: v.string(),
    emailSender: vEmailSenderConfig,
    codeLength: v.optional(v.number()),
    ttlMs: v.optional(v.number()),
    subject: v.optional(v.string()),
    intro: v.optional(v.string()),
  },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const codeLength = args.codeLength ?? SIGN_IN_CODE_LENGTH_DEFAULT;
    if (
      !Number.isInteger(codeLength) ||
      codeLength < SIGN_IN_CODE_LENGTH_MIN ||
      codeLength > SIGN_IN_CODE_LENGTH_MAX
    ) {
      throw new Error(
        `codeLength must be an integer between ${SIGN_IN_CODE_LENGTH_MIN} ` +
          `and ${SIGN_IN_CODE_LENGTH_MAX}, got ${codeLength}`,
      );
    }
    const ttlMs = args.ttlMs ?? SIGN_IN_TTL_DEFAULT_MS;
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs < SIGN_IN_TTL_MIN_MS ||
      ttlMs > SIGN_IN_TTL_MAX_MS
    ) {
      throw new Error(
        `ttlMs must be between ${SIGN_IN_TTL_MIN_MS} and ` +
          `${SIGN_IN_TTL_MAX_MS}, got ${ttlMs}`,
      );
    }
    const error = await startPreconditions(ctx, args.email, "consume");
    if (error !== null) {
      return { success: false, userError: error };
    }
    const owner = await emailByNormalizedEmail(ctx, normalizeEmail(args.email));
    const created = await createCodeChallengeAndSendEmail(ctx, {
      email: owner === null ? args.email : owner.email,
      purpose: PURPOSE,
      ttlMs,
      codeLength,
      emailSender: args.emailSender,
      copy: {
        subject: args.subject ?? SIGN_IN_COPY.subject,
        intro: args.intro ?? SIGN_IN_COPY.intro,
      },
    });
    return { success: true, ...created };
  },
});

/** The arguments of `verifyCode`, `complete`, and `completeForNewUser`. */
const vCodeArgs = {
  // The code that the person typed. Spaces and hyphens are ignored.
  code: v.string(),
  // The secret that the starting browser kept.
  browserSecret: v.string(),
};

const codeFailure = v.object({
  success: v.literal(false),
  userError: completeCodeChallengeUserError,
});

const verifyCodeResult = v.union(
  v.object({
    success: v.literal(true),
    email: v.string(),
    // The user that owns `email` now, or `null` when no user does.
    userId: v.union(v.string(), v.null()),
  }),
  codeFailure,
);
type VerifyCodeResult = Infer<typeof verifyCodeResult>;

/** The owner of the address of the row, or `null`. */
async function ownerOf(ctx: MutationCtx, email: string) {
  const row = await emailByNormalizedEmail(ctx, normalizeEmail(email));
  return row === null ? null : row.userId;
}

/**
 * Verify the typed code without claiming the challenge, and give the user
 * that owns the address, or `null` when no user does. The method calls it
 * first, then `complete` for an owner, or
 * `_internal_dangerous_completeForNewUser` for a user that it creates, in the
 * same mutation.
 *
 * Unlike the `check` of the other challenges, which tells whether `start`
 * would fail and uses nothing, this function uses an attempt for a wrong
 * code. Thus it is a mutation.
 *
 * The wrong code that uses the last attempt deletes the challenge and gives
 * `TOO_MANY_ATTEMPTS`. The count holds only if the caller's mutation commits,
 * thus the caller must return a failure to the client, not throw.
 */
export const verifyCode = mutation({
  args: vCodeArgs,
  returns: verifyCodeResult,
  handler: async (ctx, args): Promise<VerifyCodeResult> => {
    const verified = await verifyCodeChallenge(ctx, {
      ...args,
      purpose: PURPOSE,
    });
    if (!verified.success) {
      return verified.failure;
    }
    const { email } = verified.row;
    return { success: true, email, userId: await ownerOf(ctx, email) };
  },
});

const completeResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    email: v.string(),
  }),
  codeFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `signIn` challenge for an address that a user owns, and return
 * this user. A wrong code counts as in `verifyCode`.
 *
 * Throws when no user owns the address: it is an application bug. Call
 * `verifyCode` first, and `_internal_dangerous_completeForNewUser` when it gives
 * no user.
 */
export const complete = mutation({
  args: vCodeArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimCodeChallenge(ctx, { ...args, purpose: PURPOSE });
    if (!claim.success) {
      return claim.failure;
    }
    const { email } = claim.row;
    const userId = await ownerOf(ctx, email);
    if (userId === null) {
      throw new Error(
        "Cannot complete the signIn challenge: no user owns the address. " +
          "Use _internal_dangerous_completeForNewUser for a new user.",
      );
    }
    return { success: true, userId, email };
  },
});

/**
 * Complete a `signIn` challenge for an address that no user owns: record the
 * address as the primary email address of `newUserId`, a user that the
 * sign-in has just created. A wrong code counts as in `verifyCode`.
 *
 * Throws when a user owns the address, or when `newUserId` already has an
 * email address: both are application bugs. Call `verifyCode` first, and call this
 * function only when it gives no user.
 *
 * DANGER: this records the address on `newUserId` with no further check, thus
 * a `newUserId` that is not the user that the same mutation has just created
 * lets the person who typed the code attach their address to another user.
 */
export const _internal_dangerous_completeForNewUser = mutation({
  args: { ...vCodeArgs, newUserId: v.string() },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimCodeChallenge(ctx, {
      code: args.code,
      browserSecret: args.browserSecret,
      purpose: PURPOSE,
    });
    if (!claim.success) {
      return claim.failure;
    }
    const { email } = claim.row;
    if ((await ownerOf(ctx, email)) !== null) {
      throw new Error(
        "Cannot complete the signIn challenge for a new user: a user " +
          "already owns the address. Use complete instead.",
      );
    }
    if (await userHasEmail(ctx, args.newUserId)) {
      throw new Error(
        "Cannot complete the signIn challenge for a new user: the user " +
          "already has an email address. Give only a user that the same " +
          "mutation has just created.",
      );
    }
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: normalizeEmail(email),
      userId: args.newUserId,
      isPrimary: true,
    });
    return { success: true, userId: args.newUserId, email };
  },
});
