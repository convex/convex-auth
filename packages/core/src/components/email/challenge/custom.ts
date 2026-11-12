// The `custom` challenge: prove that the person who started the flow
// controls an address, for a purpose that the application defines. Examples:
// account recovery, a magic link, or a new verification before a dangerous
// action. Completion writes nothing to the component.
//
// The `purpose` string is opaque to the component. The caller gives the same
// string at start and at completion; a different string fails. Give each purpose a name that another library or flow does not
// use, for example `"myApp/reauthenticate"`.

import { Infer, ObjectType, v } from "convex/values";
import { mutation, query, type QueryCtx } from "../_generated/server.ts";
import {
  CUSTOM_TTL_DEFAULT_MS,
  CUSTOM_TTL_MAX_MS,
  CUSTOM_TTL_MIN_MS,
  emailByNormalizedEmail,
} from "../helpers.ts";
import {
  completeChallengeUserError,
  wrongUserUserError,
  normalizeEmail,
  startChallengeUserError,
} from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startChallengeResult,
  startPreconditions,
  createChallengeAndSendEmail,
  claimChallenge,
  findClaimableChallenge,
  type ChallengeOfKind,
  type StartChallengeResult,
} from "./common.ts";
import { attestUser } from "../../custom.ts";

// The application's name for the flow. Opaque to the component.
const vPurposeName = v.string();

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * without consuming the rate limits.
 *
 * An application that must write before it calls `start` (for example,
 * create the user) calls `check` first and stops on an error, so the write
 * is not committed when the flow cannot start. When `check` passes, a
 * `start` in the same mutation does not return a `userError`: both run in
 * one transaction, so the limits cannot change in between.
 */
export const check = mutation({
  args: { email: v.string() },
  returns: v.union(startChallengeUserError, v.null()),
  handler: (ctx, { email }) => startPreconditions(ctx, email, "check"),
});

/**
 * Start a `custom` challenge.
 *
 * `subject` and `intro` are the first lines of the email; the component
 * appends the link and the expiry. `ttlMs` bounds how long the link works;
 * it must stay between `CUSTOM_TTL_MIN_MS` and `CUSTOM_TTL_MAX_MS`. A value
 * outside these bounds is a programming error and throws.
 */
export const start = mutation({
  args: {
    ...vStartArgs,
    purpose: vPurposeName,
    // The user that must complete the flow and own the address, or `null`
    // when no user is signed in (for example, account recovery).
    //
    // With a user ID, `complete` succeeds only if `currentUserId` is this
    // user and the address is still a verified address of this user when
    // `complete` runs. The user verified it before the flow started (for
    // example, with `addEmail`).
    //
    // With `null`, `complete` accepts any `currentUserId` and does not check
    // the owner of the address: it gives the owner in `emailOwnerId`, or
    // `null` when no user has verified the address. `null` does NOT require
    // that the address has no owner.
    expectedUserId: v.union(v.string(), v.null()),
    subject: v.string(),
    intro: v.string(),
    ttlMs: v.optional(v.number()),
  },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const ttlMs = args.ttlMs ?? CUSTOM_TTL_DEFAULT_MS;
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs < CUSTOM_TTL_MIN_MS ||
      ttlMs > CUSTOM_TTL_MAX_MS
    ) {
      throw new Error(
        `ttlMs must be between ${CUSTOM_TTL_MIN_MS} and ${CUSTOM_TTL_MAX_MS}, ` +
          `got ${ttlMs}`,
      );
    }
    const error = await startPreconditions(ctx, args.email, "consume");
    if (error !== null) {
      return { success: false, userError: error };
    }
    const created = await createChallengeAndSendEmail(ctx, {
      email: args.email,
      purpose: {
        kind: "custom",
        userId: args.expectedUserId ?? undefined,
        purpose: args.purpose,
      },
      ttlMs,
      url: args.url,
      emailSender: args.emailSender,
      copy: { subject: args.subject, intro: args.intro },
    });
    return { success: true, ...created };
  },
});

const completeResult = v.union(
  v.object({
    success: v.literal(true),
    email: v.string(),
    // The user that `email` is a verified address of when `complete` runs,
    // or `null` when it is no user's verified address. When `start` got a
    // user ID, it is this user.
    emailOwnerId: v.union(v.string(), v.null()),
    // `complete` only: a user attestation for `emailOwnerId`, because the
    // person proved control of a verified address of that user. `null` when
    // `emailOwnerId` is `null`. `peek` does not attest.
    attestation: v.optional(v.union(v.string(), v.null())),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(completeChallengeUserError, wrongUserUserError),
  }),
);
type CompleteResult = Infer<typeof completeResult>;

/** The claim arguments of `peek` and `complete`. */
const vCompleteArgs = {
  ...vClaimArgs,
  purpose: vPurposeName,
  currentUserId: v.union(v.string(), v.null()),
};

/** The purpose that `peek` and `complete` expect. */
function expectedPurpose(args: ObjectType<typeof vCompleteArgs>) {
  return {
    kind: "custom" as const,
    userId: args.currentUserId ?? undefined,
    purpose: args.purpose,
  };
}

/** The result of `peek` and `complete` for a claimable challenge. */
async function claimableResult(
  ctx: QueryCtx,
  row: ChallengeOfKind<"custom">,
): Promise<CompleteResult> {
  const owner = await emailByNormalizedEmail(ctx, normalizeEmail(row.email));
  const emailOwnerId = owner === null ? null : owner.userId;
  const expectedUserId = row.purpose.userId;
  if (expectedUserId !== undefined && emailOwnerId !== expectedUserId) {
    console.warn(
      `Rejected the email challenge ${row._id} for the purpose "custom": ` +
        `the expected user does not own the address now.`,
    );
    return { success: false, userError: { error: "INVALID_CHALLENGE" } };
  }
  return { success: true, email: row.email, emailOwnerId };
}

/**
 * Report what `complete` would return for this link, without claiming it. A
 * landing page calls it to tell the user that a link is dead before it asks
 * for input. It is a query, thus a subscribed page learns that the link was
 * claimed elsewhere, or that the cleanup loop erased it after it expired.
 * It takes the same arguments as `complete`.
 *
 * A `peek` that passes does not guarantee that a later `complete` passes:
 * the link can expire or be claimed between the two calls.
 */
export const peek = query({
  args: vCompleteArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await findClaimableChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: expectedPurpose(args),
    });
    if (!claim.success) {
      return claim.failure;
    }
    return await claimableResult(ctx, claim.row);
  },
});

/**
 * Complete a `custom` challenge. The `purpose` must be the one given at
 * start.
 *
 * `currentUserId` is the user that is signed in now, or `null` when no user
 * is. When `start` got a user ID, `currentUserId` must be this user. Another
 * value fails with `WRONG_USER` and keeps the challenge, thus this user can
 * still complete it. When `start` got `null`, any value is
 * accepted. It is required, thus a caller cannot skip the check by
 * accident.
 *
 * When `start` got a user ID and this user does not own the address now,
 * `complete` fails with `INVALID_CHALLENGE`: after the start, the address
 * moved to another user or was removed. The claim still deletes the row,
 * thus the link does not work again.
 */
export const complete = mutation({
  args: vCompleteArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: expectedPurpose(args),
    });
    if (!claim.success) {
      return claim.failure;
    }
    const result = await claimableResult(ctx, claim.row);
    if (!result.success) {
      return result;
    }
    return {
      ...result,
      attestation:
        result.emailOwnerId === null
          ? null
          : await attestUser(ctx, { verifiedUserId: result.emailOwnerId }),
    };
  },
});
