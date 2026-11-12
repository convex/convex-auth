/**
 * TOTP enrollment: the functions of the component that a signed-in user
 * reaches from a settings page to set the second factor up.
 *
 * A user may have up to {@link MAX_TOTPS_PER_USER} TOTPs in the "active"
 * status, one for each authenticator app, and at most one in the "pending"
 * status. An active TOTP is one that the user confirmed with a valid code
 * generated from the shared secret. A user with any active TOTP owes a code at
 * sign-in, and a code from any of them is accepted (see {@link getStatus} and
 * {@link listTotps}). A pending TOTP is one that is awaiting a call to
 * {@link confirmTotp} to move it to the active status. It can be confirmed
 * for {@link PENDING_ENROLLMENT_TTL_MS} after its creation.
 *
 * @module
 */
import { mutation, MutationCtx, query } from "./_generated/server.ts";
import { verifyCurrentUser } from "../custom.ts";
import { Doc } from "./_generated/dataModel.ts";
import { Infer, v } from "convex/values";
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  base32Encode,
  generateSecret,
  otpauthUri,
} from "./totp.ts";
import { confirmMultiTotpUserError } from "./validation.ts";
import {
  activeSecrets,
  backupCodesByUserId,
  hasActiveSecret,
  matchCode,
  pendingSecret,
  replaceBackupCodes,
} from "./helpers.ts";

const createTotpResult = v.object({
  // The base32-encoded secret, for a user who types it into the authenticator
  // app by hand.
  secret: v.string(),
  // The `otpauth://` URI, for a QR code that the authenticator app scans.
  otpauthUri: v.string(),
});
type CreateTotpResult = Infer<typeof createTotpResult>;

// How long a pending secret can be confirmed after `createTotp` made it.
export const PENDING_ENROLLMENT_TTL_MS = 60 * 60 * 1000; // 1 hour

// How many active secrets a user can have. Every code a user gives is checked
// against each of them, thus the limit bounds that work, and it is well above
// the number of authenticator apps a person keeps.
export const MAX_TOTPS_PER_USER = 10;

/**
 * Start the TOTP enrollment of the signed-in user: generate a new secret.
 * `currentUser` is the current-user attestation of the core
 * (`attestCurrentUser`).
 *
 * The new secret is *pending*: its use should not be enforced at sign-in until
 * the user proves that their authenticator has it, with `confirmTotp`.
 *
 * The active TOTPs that a user has enrolled already keep working: confirming
 * the new one with `confirmTotp` adds it next to them. If a pending
 * enrollment was abandoned, a subsequent call replaces it.
 *
 * `issuerDisplayName` names the application and `accountDisplayName` names the
 * account (for example the user's email address). Both are shown in the
 * authenticator app.
 */
export const createTotp = mutation({
  args: {
    currentUser: v.string(),
    issuerDisplayName: v.string(),
    accountDisplayName: v.string(),
  },
  returns: createTotpResult,
  handler: async (
    ctx,
    { currentUser, issuerDisplayName, accountDisplayName },
  ): Promise<CreateTotpResult> => {
    const { userId } = await verifyCurrentUser(currentUser);
    const secret = generateSecret();
    const params = {
      algorithm: DEFAULT_ALGORITHM,
      digits: DEFAULT_DIGITS,
      period: DEFAULT_PERIOD,
    };

    const pending = await pendingSecret(ctx, userId);
    if (pending !== null) {
      await ctx.db.delete("totpSecrets", pending._id);
    }
    await ctx.db.insert("totpSecrets", {
      userId,
      secret: secret.buffer,
      ...params,
      status: "pending",
    });

    const encodedSecret = base32Encode(secret);
    return {
      secret: encodedSecret,
      otpauthUri: otpauthUri({
        secret: encodedSecret,
        ...params,
        issuer: issuerDisplayName,
        accountName: accountDisplayName,
      }),
    };
  },
});

const confirmTotpResult = v.union(
  v.object({
    success: v.literal(true),
    // The id of the new active secret.
    totpId: v.string(),
    // The new backup codes, in the form the user sees them, when this
    // secret turned the second factor on: the user had no active secret
    // before. A user who adds an authenticator keeps the backup codes they
    // have. This is the only time the component returns them: it stores
    // only their hashes.
    backupCodes: v.optional(v.array(v.string())),
  }),
  v.object({
    success: v.literal(false),
    userError: confirmMultiTotpUserError,
  }),
);
type ConfirmTotpResult = Infer<typeof confirmTotpResult>;

/**
 * Finish the TOTP enrollment of the signed-in user: check a code against the
 * pending secret, and activate it next to the active secrets the user has
 * already. `currentUser` is the current-user attestation of the core
 * (`attestCurrentUser`).
 *
 * The first active secret of a user comes with a new set of backup codes. A
 * user who adds a second authenticator keeps their backup codes. The code that
 * confirmed the secret cannot be used again to sign in.
 *
 * `NO_PENDING_ENROLLMENT` is for a user with no pending secret: the app has
 * not called `createTotp`, the enrollment was confirmed already (in another
 * tab, say), or it was created too long ago. `TOO_MANY_TOTPS` is for a user
 * who has {@link MAX_TOTPS_PER_USER} active secrets already; the pending
 * secret stays, and can be confirmed once the user deletes one.
 */
export const confirmTotp = mutation({
  args: { currentUser: v.string(), code: v.string() },
  returns: confirmTotpResult,
  handler: async (ctx, { currentUser, code }): Promise<ConfirmTotpResult> => {
    const { userId } = await verifyCurrentUser(currentUser);
    const pending = await confirmablePendingSecret(ctx, userId);
    if (pending === null) {
      return { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } };
    }
    const active = await activeSecrets(ctx, userId);
    if (active.length >= MAX_TOTPS_PER_USER) {
      return { success: false, userError: { error: "TOO_MANY_TOTPS" } };
    }
    if (!(await activate(ctx, pending, code))) {
      return { success: false, userError: { error: "INCORRECT_CODE" } };
    }
    if (active.length > 0) {
      return { success: true, totpId: pending._id };
    }
    const backupCodes = await replaceBackupCodes(ctx, userId);
    return { success: true, totpId: pending._id, backupCodes };
  },
});

/**
 * The pending secret of a user while it can still be confirmed, `null` when
 * there is none or it is too old.
 */
async function confirmablePendingSecret(
  ctx: MutationCtx,
  userId: string,
): Promise<Doc<"totpSecrets"> | null> {
  const pending = await pendingSecret(ctx, userId);
  if (
    pending === null ||
    Date.now() - pending._creationTime >= PENDING_ENROLLMENT_TTL_MS
  ) {
    return null;
  }
  return pending;
}

/**
 * Check a code against a pending secret and, when it matches, make the
 * secret active, with the step of the code marked used. Return whether the
 * code matched.
 */
async function activate(
  ctx: MutationCtx,
  pending: Doc<"totpSecrets">,
  code: string,
): Promise<boolean> {
  const matchedCounter = await matchCode(pending, code, Date.now());
  if (matchedCounter === null) {
    return false;
  }
  await ctx.db.patch("totpSecrets", pending._id, {
    status: "active",
    lastUsedCounter: matchedCounter,
  });
  return true;
}

const totpStatus = v.object({
  // `true` when the user has at least one active secret that they confirmed.
  enabled: v.boolean(),
  remainingBackupCodes: v.number(),
});
type TotpStatus = Infer<typeof totpStatus>;

/**
 * Get the TOTP status of a user.
 *
 * A pending enrollment is not reported: the app cannot resume one (the
 * secret is returned once, by `createTotp`), only start over.
 */
export const getStatus = query({
  args: { userId: v.string() },
  returns: totpStatus,
  handler: async (ctx, { userId }): Promise<TotpStatus> => {
    const [enabled, backupCodes] = await Promise.all([
      hasActiveSecret(ctx, userId),
      backupCodesByUserId(ctx, userId),
    ]);
    return {
      enabled,
      remainingBackupCodes: backupCodes.length,
    };
  },
});

const totpSummary = v.object({
  // The id of the active secret.
  totpId: v.string(),
  // When the enrollment of the secret started, in milliseconds since the
  // epoch. It was confirmed within `PENDING_ENROLLMENT_TTL_MS` of this.
  createdAt: v.number(),
});
type TotpSummary = Infer<typeof totpSummary>;

/**
 * List the active secrets of a user, oldest first, for a settings page that
 * lets the user delete one of their authenticators. The secrets themselves
 * are never returned. A pending enrollment is not listed, as for
 * {@link getStatus}.
 */
export const listTotps = query({
  args: { userId: v.string() },
  returns: v.array(totpSummary),
  handler: async (ctx, { userId }): Promise<TotpSummary[]> => {
    const active = await activeSecrets(ctx, userId);
    return active.map((row) => ({
      totpId: row._id,
      createdAt: row._creationTime,
    }));
  },
});
