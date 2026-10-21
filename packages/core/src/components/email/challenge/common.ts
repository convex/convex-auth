/**
 * The server code that the challenge kinds share.
 *
 * Challenges prove that the current user has access to an email address.
 * Each challenge has two steps: creating it (which sends the email),
 * and then completing it (which receives the code in the email).
 *
 * There are two secrets for each challenge:
 *
 * - The `emailCode`, which travels in the emailed link.
 * - The `browserSecret`, which stays in the browser that started the challenge
 *   (either in page’s temporary state, or in local storage).
 *   The browser gets it from the `start` mutation and keeps it the page state
 *   (e.g. `useState`) for single-page flows, or local storage for multiple-page
 *   flows.
 *
 * Because both secrets are necessary, a person who reads the mailbox alone cannot
 * complete the challenge (which avoids attacks where a malicious user tricks the user
 * into completing a challenge for an account they control), and neither can a person
 * who uses the browser alone but doesn’t have access to the email address.
 *
 * The start step makes the row and sends the link:
 *
 * ```
 *  Client                    Method                          Component
 *    │                         │                               │
 *    │  submit the address     │                               │
 *    ├────────────────────────▶│                               │
 *    │                         │  challenge start mutation     │
 *    │                         ├──────────────────────────────▶│     check the format, then the rate limits
 *    │                         │                               │     store the hashes of the code and the secret
 *    │                         │                               ├─▶ send the link by email
 *    │                         │◀──────────────────────────────┤     the secret and the ID of the challenge
 *    │◀────────────────────────┤                               │
 *    ├─▶ keep the secret in page state/local storage           │
 *    │                         │                               │
 * ```
 *
 * The completion step runs when the landing page opens with a link. The page
 * reads the code from the URL and the secret from storage, then completes at
 * once:
 *
 * ```
 *  Landing page                Method                            Component
 *    │                           │                                 │
 *    ├─▶ read the code from the URL and the secret from storage    │
 *    │                           │                                 │
 *    │  complete                 │                                 │
 *    ├──────────────────────────▶│                                 │
 *    │                           │  challenge complete mutation    │
 *    │                           ├────────────────────────────────▶│     find the row by the secret, then verify the code
 *    │                           │                                 │     delete the row, then make the change that the kind defines
 *    │                           │◀────────────────────────────────┤
 *    │◀──────────────────────────┤                                 │
 *    ├─▶ show the result                                           │
 *    │                           │                                 │
 * ```
 *
 * The `purpose` of the row says which kind started the challenge, and which
 * user the flow is for. A `complete` call gives the purpose that it expects,
 * thus a link for one flow can never complete another flow, or a flow for
 * another user.
 *
 * The secret identifies the challenge, and the code proves access to the
 * mailbox. The row goes away only when the claim succeeds, thus no link works
 * twice, and a person who has only the link cannot burn the challenge. A
 * missing or expired row gives `INVALID_CHALLENGE`, and a wrong code gives
 * `INCORRECT_CODE`. A challenge of another user gives `WRONG_USER` and
 * stays. A challenge of another kind or purpose throws, because it is an
 * application bug and not a user error.
 *
 * @module
 */

import { Infer, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server.ts";
import type { Doc, Id } from "../_generated/dataModel.ts";
import { generateRandomToken, sha256Hex } from "../../../lib/crypto.ts";
import { scheduleChallengeCleanup } from "../cleanup.ts";
import {
  rateLimiter,
  getClientIp,
  emailByNormalizedEmail,
  buildLink,
  sendChallengeEmail,
  type ChallengeEmailCopy,
} from "../helpers.ts";
import {
  startChallengeUserError,
  startFreeAddressUserError,
  completeFreeAddressUserError,
  normalizeEmail,
  validateEmailFormat,
  vEmailSenderConfig,
  type EmailSenderConfig,
  type EmailTakenUserError,
  type StartChallengeUserError,
  type StartFreeAddressUserError,
  type CompleteChallengeUserError,
  type WrongUserUserError,
  wrongUserUserError,
} from "../validation.ts";

export type ChallengePurpose = Doc<"challenges">["purpose"];

//------------------------------------------------------------------------------
// Shared validators
//------------------------------------------------------------------------------

/** The arguments that every `start` mutation accepts. */
export const vStartArgs = {
  email: v.string(),
  // The base URL for the link. This should be a constant set by the app
  // (e.g. "https://example.com/verify"). The code is appended as the `code`
  // query parameter.
  url: v.string(),
  emailSender: vEmailSenderConfig,
};

/** The arguments that every `complete` mutation accepts. */
export const vClaimArgs = {
  // The code from the emailed link.
  emailCode: v.string(),
  // The secret that the starting browser kept.
  browserSecret: v.string(),
};

const startChallengeSuccess = v.object({
  success: v.literal(true),
  // The secret the client must keep (in its local storage) and present
  // again at completion. It never travels in the email.
  browserSecret: v.string(),
  // The new challenge. A caller that wants to keep data about the flow can
  // use this ID as a foreign reference.
  challengeId: v.id("challenges"),
});

export const startChallengeResult = v.union(
  startChallengeSuccess,
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);
export type StartChallengeResult = Infer<typeof startChallengeResult>;

/**
 * The `start` result of the kinds that record the address for a user
 * (`addEmail`, `changeEmail`, `signUp`). It adds `EMAIL_TAKEN` to the errors.
 */
export const startFreeAddressResult = v.union(
  startChallengeSuccess,
  v.object({
    success: v.literal(false),
    userError: startFreeAddressUserError,
  }),
);
export type StartFreeAddressResult = Infer<typeof startFreeAddressResult>;

/**
 * The failed `complete` result of the kinds that record the address for a
 * user. It adds `EMAIL_TAKEN` to the errors.
 */
export const completeFreeAddressFailure = v.object({
  success: v.literal(false),
  userError: completeFreeAddressUserError,
});

/**
 * The failed `complete` result of the kinds that record the address for the
 * caller (`addEmail`, `changeEmail`). It adds `WRONG_USER` to the errors of
 * `completeFreeAddressFailure`.
 */
export const completeCallerAddressFailure = v.object({
  success: v.literal(false),
  userError: v.union(completeFreeAddressUserError, wrongUserUserError),
});

/** A challenge row whose purpose has the kind `Kind`. */
export type ChallengeOfKind<Kind extends ChallengePurpose["kind"]> =
  Doc<"challenges"> & {
    purpose: Extract<ChallengePurpose, { kind: Kind }>;
  };

/**
 * The result of `findClaimableChallenge` and `claimChallenge`. The kinds
 * return `failure` as-is when the claim fails; it already has the shape of a
 * failed `complete` result. A `signUp` claim has no caller user, thus it
 * never fails with `WRONG_USER`.
 */
export type ClaimChallengeResult<
  Kind extends ChallengePurpose["kind"] = ChallengePurpose["kind"],
> =
  | { success: true; row: ChallengeOfKind<Kind> }
  | { success: false; failure: ClaimFailure<Kind> };

type ClaimFailure<Kind extends ChallengePurpose["kind"]> = {
  success: false;
  userError:
    | CompleteChallengeUserError
    | (Kind extends "signUp" ? never : WrongUserUserError);
};

function claimFailure<
  Code extends ClaimFailure<ChallengePurpose["kind"]>["userError"]["error"],
>(
  error: Code,
): {
  success: false;
  failure: { success: false; userError: { error: Code } };
} {
  return { success: false, failure: { success: false, userError: { error } } };
}

//------------------------------------------------------------------------------
// Start
//------------------------------------------------------------------------------

/**
 * The preconditions that every `start` shares: the format of the address,
 * then the two rate limits (one for the destination address, one for the
 * client IP). Returns the error to give the user, or `null` when the start
 * can go on. In `"consume"` mode, the limits take a token only when the start
 * passes all of the checks.
 */
export async function startPreconditions(
  ctx: MutationCtx,
  email: string,
  mode: "check" | "consume",
): Promise<StartChallengeUserError | null> {
  const formatError = validateEmailFormat(email);
  if (formatError !== null) {
    return formatError;
  }

  const keys = await getStartLimitKeys(ctx, email);
  const limitError = await checkStartLimits(ctx, keys);
  if (limitError !== null) {
    return limitError;
  }

  if (mode === "consume") {
    await consumeStartLimits(ctx, keys);
  }

  return null;
}

type StartLimitKeys = { emailKey: string; ipKey: string };
type RateLimitedUserError = Extract<
  StartChallengeUserError,
  { error: "RATE_LIMITED" }
>;

async function getStartLimitKeys(
  ctx: MutationCtx,
  email: string,
): Promise<StartLimitKeys> {
  return { emailKey: normalizeEmail(email), ipKey: await getClientIp(ctx) };
}

/**
 * Read the two limits of a `start` without taking a token. The callers read
 * all of the limits before any one takes a token. Otherwise a start that the
 * IP limit denies would still take a token from the address, and a blocked
 * client could lock any address out at no cost.
 */
async function checkStartLimits(
  ctx: MutationCtx,
  { emailKey, ipKey }: StartLimitKeys,
): Promise<RateLimitedUserError | null> {
  const perEmail = await rateLimiter.check(ctx, "startChallengePerEmail", {
    key: emailKey,
  });
  if (!perEmail.ok) {
    return { error: "RATE_LIMITED", retryAfterMs: perEmail.retryAfter };
  }
  const perIp = await rateLimiter.check(ctx, "startChallengePerIp", {
    key: ipKey,
  });
  if (!perIp.ok) {
    return { error: "RATE_LIMITED", retryAfterMs: perIp.retryAfter };
  }
  return null;
}

/** Take one token from each of the two limits of a `start`. */
async function consumeStartLimits(
  ctx: MutationCtx,
  { emailKey, ipKey }: StartLimitKeys,
): Promise<void> {
  await rateLimiter.limit(ctx, "startChallengePerEmail", {
    key: emailKey,
    throws: true,
  });
  await rateLimiter.limit(ctx, "startChallengePerIp", {
    key: ipKey,
    throws: true,
  });
}

/**
 * Return `EMAIL_TAKEN` when a user has already verified the address, or
 * `null` when the address is free. The kinds that record an address call
 * this at start and again at completion.
 *
 * At start, `startFreeAddressPreconditions` calls this only after it reads
 * the `lookupEmailPerIp` limit, and takes a token from that limit for each
 * answer. Otherwise the start would be an unlimited enumeration oracle.
 *
 * TODO: let the caller disable this check at start. It tells the caller if
 * an address has an account, which an app that must prevent user
 * enumeration does not want to reveal before the link is opened.
 */
export async function addressTakenError(
  ctx: QueryCtx,
  normalizedEmail: string,
): Promise<EmailTakenUserError | null> {
  const existing = await emailByNormalizedEmail(ctx, normalizedEmail);
  return existing === null ? null : { error: "EMAIL_TAKEN" };
}

/**
 * The `start` preconditions of the kinds that record the address for a user
 * (`addEmail`, `changeEmail`, `signUp`): the shared preconditions, then the
 * address must not be verified by any user.
 *
 * The result tells the caller whether the address has an account, thus it
 * also uses the `lookupEmailPerIp` limit of `lookupEmail`. Each attempt takes
 * one token from it:
 *
 * - `EMAIL_TAKEN` takes the token in both modes, because no `start` comes
 *   after it.
 * - A free address takes the token in `"consume"` mode only. When `check`
 *   passes, the `start` that comes after it takes the token.
 *
 * Each call reads the limit, even for a free address. Thus, when the limit
 * has no token, all of the addresses get `RATE_LIMITED`, and the answer does
 * not tell which addresses have an account.
 *
 * An `EMAIL_TAKEN` start takes no token from the two limits of the start,
 * because it sends no email.
 */
export async function startFreeAddressPreconditions(
  ctx: MutationCtx,
  email: string,
  mode: "check" | "consume",
): Promise<StartFreeAddressUserError | null> {
  const formatError = validateEmailFormat(email);
  if (formatError !== null) {
    return formatError;
  }

  const keys = await getStartLimitKeys(ctx, email);
  const limitError = await checkStartLimits(ctx, keys);
  if (limitError !== null) {
    return limitError;
  }
  const lookup = await rateLimiter.check(ctx, "lookupEmailPerIp", {
    key: keys.ipKey,
  });
  if (!lookup.ok) {
    return { error: "RATE_LIMITED", retryAfterMs: lookup.retryAfter };
  }

  const takenError = await addressTakenError(ctx, keys.emailKey);
  if (takenError !== null || mode === "consume") {
    await rateLimiter.limit(ctx, "lookupEmailPerIp", {
      key: keys.ipKey,
      throws: true,
    });
  }
  if (takenError !== null) {
    return takenError;
  }

  if (mode === "consume") {
    await consumeStartLimits(ctx, keys);
  }
  return null;
}

/**
 * Store the hashed code + secret and send the email. Returns the secret that
 * the starting browser keeps, and the ID of the new row.
 */
export async function createChallengeAndSendEmail(
  ctx: MutationCtx,
  args: {
    email: string;
    purpose: ChallengePurpose;
    ttlMs: number;
    url: string;
    emailSender: EmailSenderConfig;
    copy: ChallengeEmailCopy;
  },
): Promise<{ browserSecret: string; challengeId: Id<"challenges"> }> {
  const emailCode = generateRandomToken();
  const browserSecret = generateRandomToken();
  const challengeId = await ctx.db.insert("challenges", {
    email: args.email,
    purpose: args.purpose,
    emailCodeHash: await sha256Hex(emailCode),
    browserSecretHash: await sha256Hex(browserSecret),
    expiresAt: Date.now() + args.ttlMs,
  });
  await scheduleChallengeCleanup(ctx, args.ttlMs);
  await sendChallengeEmail(ctx, args.emailSender, {
    to: args.email,
    copy: args.copy,
    link: buildLink(args.url, emailCode),
    ttlMs: args.ttlMs,
  });
  return { browserSecret, challengeId };
}

//------------------------------------------------------------------------------
// Complete
//------------------------------------------------------------------------------

/**
 * The purpose that a `complete` call expects. For `signUp`, it has no
 * `userId`: the caller has no session, thus `complete` takes the user from
 * the row.
 */
export type ExpectedPurpose =
  Exclude<ChallengePurpose, { kind: "signUp" }> | { kind: "signUp" };

function sameKind<Expected extends ExpectedPurpose>(
  row: Doc<"challenges">,
  expected: Expected,
): row is ChallengeOfKind<Expected["kind"]> {
  const actual = row.purpose;
  // Two `custom` challenges match only when the caller's purpose string is
  // the same one that started the flow.
  if (actual.kind === "custom" && expected.kind === "custom") {
    return actual.purpose === expected.purpose;
  }
  return actual.kind === expected.kind;
}

function sameUser(row: Doc<"challenges">, expected: ExpectedPurpose): boolean {
  const actual = row.purpose;
  // A `signUp` call has no session: `complete` takes the user from the row.
  if (expected.kind === "signUp" || actual.kind === "signUp") {
    return true;
  }
  // A `custom` challenge that expects no user matches any caller: it does
  // not give access to an account.
  if (actual.kind === "custom" && actual.userId === undefined) {
    return true;
  }
  return actual.userId === expected.userId;
}

/**
 * Find the challenge that the code from the link and the secret from the
 * starting browser can claim, without claiming it. Returns the row when all
 * of the checks pass, or the failure that the `complete` mutation returns to
 * the client.
 *
 * The secret identifies the challenge, and the code proves access to the
 * mailbox. A caller without the secret cannot reach the row, so a person who
 * reads the mailbox alone can neither complete the challenge nor burn it.
 *
 * `INVALID_CHALLENGE` means that there is no live challenge for the secret.
 * The challenge may have expired, may already have been used, or may never
 * have existed. The client cannot tell these apart, and the user action is
 * the same, start again. The server writes the difference to the log, to
 * help you find a bug or a misuse. `INCORRECT_CODE` means the row exists but the code
 * is not the one that the challenge sent. For a link, the link is not the
 * newest one this browser started. For a future short code, it is a typo.
 *
 * `WRONG_USER` means that the challenge is for another user than the
 * caller. This occurs in normal use: a user starts a flow, signs out, and
 * another user signs in in the same browser. The row stays, thus the right
 * user can still complete the challenge.
 *
 * A challenge of another kind, or a `custom` challenge with another purpose
 * string, throws. It is an application bug: the landing page called the
 * wrong function. A `signUp` call gives no `userId`, thus only the kind must
 * match. A `custom` challenge without a `userId` matches any `userId`.
 */
export async function findClaimableChallenge<Expected extends ExpectedPurpose>(
  ctx: QueryCtx,
  args: { emailCode: string; browserSecret: string; purpose: Expected },
): Promise<ClaimChallengeResult<Expected["kind"]>> {
  const browserSecretHash = await sha256Hex(args.browserSecret);
  const row = await ctx.db
    .query("challenges")
    .withIndex("by_browserSecretHash", (q) =>
      q.eq("browserSecretHash", browserSecretHash),
    )
    .unique();
  if (row === null) {
    console.warn(
      `Rejected the email challenge: there is no challenge for the browser ` +
        `secret. The challenge was already completed, or it never existed.`,
    );
    return claimFailure("INVALID_CHALLENGE");
  }
  // At exactly `expiresAt` the link is expired, like in the cleanup loop.
  if (row.expiresAt <= Date.now()) {
    console.warn(
      `Rejected the email challenge ${row._id} for the purpose ` +
        `"${row.purpose.kind}": it expired at ` +
        `${new Date(row.expiresAt).toISOString()}.`,
    );
    return claimFailure("INVALID_CHALLENGE");
  }
  if (row.emailCodeHash !== (await sha256Hex(args.emailCode))) {
    console.warn(
      `Rejected the email challenge ${row._id} for the purpose ` +
        `"${row.purpose.kind}": the code is not the code that this ` +
        `challenge sent.`,
    );
    return claimFailure("INCORRECT_CODE");
  }
  if (!sameKind(row, args.purpose)) {
    throw new Error(
      `Challenge purpose mismatch: the row is for "${row.purpose.kind}", but the complete call expects "${args.purpose.kind}"`,
    );
  }
  if (!sameUser(row, args.purpose)) {
    console.warn(
      `Rejected the email challenge ${row._id} for the purpose ` +
        `"${row.purpose.kind}": it is for another user than the caller.`,
    );
    // `sameUser` accepts any `signUp` claim, thus `Expected` is not `signUp`.
    return claimFailure("WRONG_USER") as ClaimChallengeResult<Expected["kind"]>;
  }
  return { success: true, row };
}

/**
 * Claim a challenge: run the checks of {@link findClaimableChallenge}, then
 * delete the row. The row is deleted only when the claim succeeds, so a
 * claimed link can never be replayed.
 */
export async function claimChallenge<Expected extends ExpectedPurpose>(
  ctx: MutationCtx,
  args: { emailCode: string; browserSecret: string; purpose: Expected },
): Promise<ClaimChallengeResult<Expected["kind"]>> {
  const claim = await findClaimableChallenge(ctx, args);
  if (claim.success) {
    await ctx.db.delete("challenges", claim.row._id);
  }
  return claim;
}
