import { isoUint8Array, toHash } from "@simplewebauthn/server/helpers";
import { Doc, Id } from "./_generated/dataModel.ts";
import { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { CHALLENGE_TTL_MS } from "./constants.ts";

/**
 * Run `read` and return its value. Return `null` when it throws.
 */
export function okOrNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * Tell whether the relying party ID hash inside authenticator data names the
 * expected relying party.
 *
 * `verifyRegistrationResponse` and `verifyAuthenticationResponse` check this
 * too. It is checked separately, and first, because a mismatch is almost
 * always a misconfigured `rpId`. The message of the library names the check
 * that failed; this one names the setting of the method to correct.
 */
export async function rpIdHashMatches(
  rpIdHash: Uint8Array<ArrayBuffer>,
  expectedRpId: string,
): Promise<boolean> {
  return isoUint8Array.areEqual(rpIdHash, await toHash(expectedRpId));
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);
}

export function randomChallenge(): ArrayBuffer {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  return toArrayBuffer(challenge);
}

export function randomHandle(): ArrayBuffer {
  // 64 bytes is the WebAuthn maximum length for `user.id`.
  const handle = new Uint8Array(64);
  crypto.getRandomValues(handle);
  return toArrayBuffer(handle);
}

/**
 * Find a challenge by its bytes and its kind. Return `null` when no row
 * matches.
 *
 * The function does not check the TTL, and can return expired challenges.
 * Callers must check the TTL by themselves.
 */
export async function findChallenge<
  Kind extends "registration" | "authentication",
>(
  ctx: QueryCtx,
  kind: Kind,
  challenge: Uint8Array,
): Promise<Extract<Doc<"challenges">, { kind: Kind }> | null> {
  const row = await ctx.db
    .query("challenges")
    .withIndex("by_challenge", (q) =>
      // It’s okay for this lookup to not be guaranteed to be constant-time:
      // knowing the challenge doesn’t prove anything, issuing a valid
      // assertion for that challenge does.
      q.eq("challenge", toArrayBuffer(challenge)),
    )
    .first();
  if (row === null || row.kind !== kind) {
    return null;
  }
  return row as Extract<Doc<"challenges">, { kind: Kind }>;
}

/**
 * Find a one-use challenge by its bytes. Make sure that the challenge has
 * the correct kind and is not too old. Delete the challenge and return the
 * row. Return `null` when no usable challenge exists (unknown, incorrect
 * kind, already used, or expired).
 */
export async function consumeChallenge<
  Kind extends "registration" | "authentication",
>(
  ctx: MutationCtx,
  kind: Kind,
  challenge: Uint8Array,
): Promise<Extract<Doc<"challenges">, { kind: Kind }> | null> {
  const row = await findChallenge(ctx, kind, challenge);
  if (row === null) {
    return null;
  }
  if (isChallengeExpired(row)) {
    await deleteDeadChallenge(ctx, row);
    return null;
  }
  // One use only: a consumed challenge is deleted.
  await ctx.db.delete("challenges", row._id);
  return row;
}

/**
 * Tell if a stored challenge is too old to redeem.
 */
export function isChallengeExpired(
  row: Doc<"challenges">,
  now: number = Date.now(),
): boolean {
  // A challenge is valid for strictly less than the TTL: at exactly the
  // TTL, it is expired. The cleanup loop (see cleanup.ts) uses the same
  // boundary, so a wake-up at the deadline always finds work.
  return now - row._creationTime >= CHALLENGE_TTL_MS;
}

/**
 * Delete a challenge whose ceremony can never complete: an expired
 * challenge, or a live challenge that a failed finish attempt burns.
 */
export async function deleteDeadChallenge(
  ctx: MutationCtx,
  row: Doc<"challenges">,
): Promise<void> {
  await ctx.db.delete("challenges", row._id);

  if (row.kind === "registration") {
    await deleteUnlinkedHandle(ctx, row.handleId);
  }
}

/**
 * Delete the handle of a burned registration ceremony when no user owns it.
 *
 * A handle with `userId: null` comes from the new-account flow. When the
 * ceremony fails, no other row points at the handle. Without this cleanup,
 * the handle stays forever, because the challenge cleanup loop only finds
 * handles through their challenge rows.
 */
export async function deleteUnlinkedHandle(
  ctx: MutationCtx,
  handleId: Id<"handles">,
): Promise<void> {
  const handle = await ctx.db.get("handles", handleId);

  // In most cases the handle should exist here, but in rare cases it can be deleted
  // (if an existing user starts a passkey registration attempt, never completes it,
  // and then deletes their account before the challenge expires)
  if (handle === null) {
    return;
  }

  // If the handle is not linked to a user account,
  // it means the user never existed and we can delete the handle
  if (handle.userId === null) {
    await ctx.db.delete("handles", handle._id);
  }
}
