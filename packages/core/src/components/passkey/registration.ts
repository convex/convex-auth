/**
 * The registration ceremonies that make a passkey and store it.
 *
 * A ceremony runs in one of two flows, and the component gives each flow
 * its own pair of functions:
 *
 * - The new-user flow (`…ForNewUser`), where the user does not exist yet.
 *   The ceremony gets a handle with no owner, and the finish step links that
 *   handle to the user that the caller creates in the same transaction.
 *
 * ```
 *  Client                Method                           Component
 *    │                     │                                 │
 *    │  start the sign-up  │                                 │
 *    ├────────────────────▶│                                 │
 *    │                     │  startRegistrationForNewUser()  │
 *    │                     ├────────────────────────────────▶│     make a handle with no owner
 *    │                     │◀────────────────────────────────┤
 *    │◀────────────────────┤                                 │
 *    │                     │                                 │
 *    ├─▶ navigator.credentials.create()                      │
 *    │                     │                                 │
 *    │  finish the sign-up │                                 │
 *    ├────────────────────▶│                                 │  ┐  one mutation
 *    │                     │  checkRegistrationForNewUser()  │  │
 *    │                     ├────────────────────────────────▶│  │  verify it, write nothing
 *    │                     │◀────────────────────────────────┤  │
 *    │                     ├─▶ create the user               │  │
 *    │                     │  finishRegistrationForNewUser() │  │
 *    │                     ├────────────────────────────────▶│  │  store the passkey, own the handle
 *    │                     │◀────────────────────────────────┤  │
 *    │◀────────────────────┤                                 │  ┘
 *    │                     │                                 │
 * ```
 *
 * - The existing-user flow (`…ForExistingUser`), where a signed-in user adds
 *   a passkey. The ceremony reuses the handle of the user, and it excludes
 *   the passkeys that the user already has.
 *
 * ```
 *  Client                     Method                                     Component
 *    │                          │                                           │
 *    │  start adding a passkey  │                                           │
 *    ├─────────────────────────▶│                                           │
 *    │                          │  startRegistrationForExistingUser(userId) │
 *    │                          ├──────────────────────────────────────────▶│     reuse the handle of the user
 *    │                          │◀──────────────────────────────────────────┤
 *    │◀─────────────────────────┤                                           │
 *    │                          │                                           │
 *    ├─▶ navigator.credentials.create()                                     │
 *    │                          │                                           │
 *    │  finish adding a passkey │                                           │
 *    ├─────────────────────────▶│                                           │
 *    │                          │  finishRegistrationForExistingUser()      │
 *    │                          ├──────────────────────────────────────────▶│     store the passkey
 *    │                          │◀──────────────────────────────────────────┤
 *    │◀─────────────────────────┤                                           │
 *    │                          │                                           │
 * ```
 *
 * The flows never mix: a finish function refuses a ceremony that the other
 * start function made. The owner of the handle of the ceremony says which
 * flow started it, thus no extra field is stored.
 *
 * @module
 */

import { Infer, v } from "convex/values";
import { mutation, MutationCtx, query, QueryCtx } from "./_generated/server.ts";
import { Doc, Id } from "./_generated/dataModel.ts";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import {
  decodeAttestationObject,
  decodeClientDataJSON,
  isoBase64URL,
  parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
import {
  credentialDescriptor,
  vRegistrationResponseJSON,
  finishRegistrationUserError,
  FinishRegistrationUserError,
  deletePasskeyUserError,
  renamePasskeyUserError,
  invalidNameUserError,
  passkeyNameIsValid,
  transportsAreValid,
} from "./validation.ts";
import { SUPPORTED_ALGORITHM_IDS } from "./constants.ts";
import {
  deleteDeadChallenge,
  findChallenge,
  isChallengeExpired,
  okOrNull,
  randomChallenge,
  randomHandle,
  rpIdHashMatches,
  toArrayBuffer,
} from "./helpers.ts";
import { scheduleChallengeCleanup } from "./cleanup.ts";

/** Encode ceremony bytes the way `@simplewebauthn/server` reads them. */
function toBase64URL(bytes: ArrayBuffer): string {
  return isoBase64URL.fromBuffer(new Uint8Array(bytes));
}

//------------------------------------------------------------------------------
// Start registration
//------------------------------------------------------------------------------

/**
 * Start a registration ceremony for a user that does not exist yet.
 *
 * The function makes a handle with no owner, because the user row does not
 * exist when the ceremony starts. `finishRegistrationForNewUser` links the
 * handle to the user that the caller creates in the same transaction.
 */
export const startRegistrationForNewUser = mutation({
  args: {},
  returns: v.object({
    challenge: v.bytes(),
    // The WebAuthn user handle (`user.id`) for the `create()` call.
    userHandle: v.bytes(),
  }),
  handler: async (ctx) => {
    const handle = await insertHandle(ctx, null);
    const challenge = await insertRegistrationChallenge(ctx, handle._id);
    return { challenge, userHandle: handle.handle };
  },
});

/**
 * Start a registration ceremony for a user that already exists, for example
 * when a signed-in user adds a passkey to their account.
 */
export const startRegistrationForExistingUser = mutation({
  args: { verifiedUserId: v.string() },
  returns: v.object({
    challenge: v.bytes(),
    userHandle: v.bytes(),
    // The user’s existing credential IDs, so the authenticator refuses
    // to make a second passkey for a credential that the user already has.
    excludeCredentials: v.array(credentialDescriptor),
  }),
  handler: async (ctx, { verifiedUserId }) => {
    const existing = await ctx.db
      .query("handles")
      .withIndex("by_userId", (q) => q.eq("userId", verifiedUserId))
      .unique();
    const handle = existing ?? (await insertHandle(ctx, verifiedUserId));
    const passkeys = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", verifiedUserId))
      .collect();
    const challenge = await insertRegistrationChallenge(ctx, handle._id);
    return {
      challenge,
      userHandle: handle.handle,
      excludeCredentials: passkeys.map((row) => ({
        id: row.credentialId,
        transports: row.transports,
      })),
    };
  },
});

/**
 * Make a WebAuthn user handle. `userId` is `null` in the new-user flow,
 * where the account does not exist yet.
 */
async function insertHandle(
  ctx: MutationCtx,
  userId: string | null,
): Promise<{ _id: Id<"handles">; handle: ArrayBuffer }> {
  const handle = randomHandle();
  // A handle is 64 random bytes, so a collision is not expected. The
  // check is here for safety: two users with the same handle would let
  // one of them authenticate as the other.
  const collision = await ctx.db
    .query("handles")
    .withIndex("by_handle", (q) => q.eq("handle", handle))
    .first();
  if (collision !== null) {
    throw new Error("The new user handle collides with an existing handle.");
  }
  const _id = await ctx.db.insert("handles", { handle, userId });
  return { _id, handle };
}

async function insertRegistrationChallenge(
  ctx: MutationCtx,
  handleId: Id<"handles">,
): Promise<ArrayBuffer> {
  const challenge = randomChallenge();
  await ctx.db.insert("challenges", {
    kind: "registration",
    challenge,
    handleId,
  });
  await scheduleChallengeCleanup(ctx);
  return challenge;
}

//------------------------------------------------------------------------------
// checkRegistrationForNewUser
//------------------------------------------------------------------------------

// The arguments that the shared verification helpers examine.
const registrationCheckArgs = {
  // The expected relying party ID, usually the registrable domain
  // at which the app is served (for example, "example.com", "subdomain.example.com",
  // or "localhost"). Only web pages on the same domain (or their subdomains)
  // will be able to use that passkey.
  // See https://web.dev/articles/webauthn-rp-id
  expectedRpId: v.string(),
  // The expected origin of the ceremony (for example, "https://app.example.com").
  expectedOrigin: v.string(),
  response: vRegistrationResponseJSON,
};

const _vRegistrationCheckArgs = v.object(registrationCheckArgs);
type RegistrationCheckArgs = Infer<typeof _vRegistrationCheckArgs>;

const finishRegistrationArgs = {
  ...registrationCheckArgs,
  // The name of the passkey, for display in a settings list. The passkey
  // stays without a name when the caller gives none. See
  // {@link passkeyNameIsValid}.
  name: v.optional(v.string()),
};

const checkRegistrationResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(finishRegistrationUserError, invalidNameUserError),
  }),
);
type CheckRegistrationResult = Infer<typeof checkRegistrationResult>;

/**
 * Run the verifications of `finishRegistrationForNewUser`, without any
 * write if the registration can succeed.
 *
 * A transactional sign-up flow calls this query first, before it creates
 * the user. Because this is a query, the runtime enforces that nothing is
 * stored: there is no way to store an unverified credential through it.
 *
 * Guarantee: when `checkRegistrationForNewUser` returns `success: true`
 * inside a mutation, a `finishRegistrationForNewUser` call with the same
 * arguments in the same mutation does not return a `userError`.
 */
export const checkRegistrationForNewUser = query({
  args: finishRegistrationArgs,
  returns: checkRegistrationResult,
  handler: async (ctx, args): Promise<CheckRegistrationResult> => {
    if (args.name !== undefined && !passkeyNameIsValid(args.name)) {
      return { success: false, userError: { error: "INVALID_NAME" } };
    }
    const ceremony = await verifyRegistrationAttempt(ctx, args, {
      kind: "newUser",
    });
    if (ceremony.userError !== null) {
      return { success: false, userError: ceremony.userError };
    }
    return { success: true };
  },
});

//------------------------------------------------------------------------------
// Finish registration functions
//------------------------------------------------------------------------------

const finishRegistrationResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(finishRegistrationUserError, invalidNameUserError),
  }),
);
type FinishRegistrationResult = Infer<typeof finishRegistrationResult>;

/**
 * Finish a registration ceremony that `startRegistrationForNewUser` started.
 *
 * `newUserId` is the user that the caller creates in the same transaction.
 * The function links the handle of the ceremony to that user and stores the
 * credential.
 *
 * Each failure comes back as a `userError`. A client that does not respect
 * the WebAuthn protocol gets `PROTOCOL_ERROR`, and the backend logs say
 * which check failed.
 *
 * A caller that wants to be sure that this call succeeds before it creates
 * data can call {@link checkRegistrationForNewUser} first, in the same mutation.
 */
export const finishRegistrationForNewUser = mutation({
  args: { ...finishRegistrationArgs, newUserId: v.string() },
  returns: finishRegistrationResult,
  handler: async (ctx, args): Promise<FinishRegistrationResult> => {
    if (args.name !== undefined && !passkeyNameIsValid(args.name)) {
      return { success: false, userError: { error: "INVALID_NAME" } };
    }
    const result = await consumeRegistration(ctx, args, { kind: "newUser" });
    if (result.userError !== null) {
      return { success: false, userError: result.userError };
    }
    const existingHandle = await ctx.db
      .query("handles")
      .withIndex("by_userId", (q) => q.eq("userId", args.newUserId))
      .first();
    if (existingHandle !== null) {
      // Invariant: the new-user flow only runs for a brand-new user, which
      // cannot have a handle already.
      throw new Error(
        "Invariant violation: The user already has a different handle. finishRegistrationForNewUser is being called for a user that is not new.",
      );
    }
    await ctx.db.patch("handles", result.handle._id, {
      userId: args.newUserId,
    });
    const passkeyId = await ctx.db.insert("passkeys", {
      userId: args.newUserId,
      name: args.name,
      transports: args.response.response.transports,
      credentialId: result.credential.credentialId,
      publicKey: result.credential.publicKey,
      counter: result.credential.counter,
    });
    return { success: true, passkeyId };
  },
});

/**
 * Finish a registration ceremony that `startRegistrationForExistingUser`
 * started.
 *
 * `verifiedUserId` is the signed-in user that adds the passkey. The caller
 * must have authenticated that user. It must be the same user that started
 * the ceremony.
 *
 * The function verifies the attestation with `@simplewebauthn/server`. Then
 * it stores the credential.
 *
 * Each failure comes back as a `userError`. A client that does not respect
 * the WebAuthn protocol gets `PROTOCOL_ERROR`, and the backend logs say
 * which check failed. A ceremony that `startRegistrationForNewUser` started
 * gets `PROTOCOL_ERROR` too: only `finishRegistrationForNewUser` can finish
 * it. A ceremony that a different user started gets `PROTOCOL_ERROR` too.
 */
export const finishRegistrationForExistingUser = mutation({
  args: { ...finishRegistrationArgs, verifiedUserId: v.string() },
  returns: finishRegistrationResult,
  handler: async (ctx, args): Promise<FinishRegistrationResult> => {
    if (args.name !== undefined && !passkeyNameIsValid(args.name)) {
      return { success: false, userError: { error: "INVALID_NAME" } };
    }
    const result = await consumeRegistration(ctx, args, {
      kind: "existingUser",
      userId: args.verifiedUserId,
    });
    if (result.userError !== null) {
      return { success: false, userError: result.userError };
    }
    const passkeyId = await ctx.db.insert("passkeys", {
      userId: args.verifiedUserId,
      name: args.name,
      transports: args.response.response.transports,
      credentialId: result.credential.credentialId,
      publicKey: result.credential.publicKey,
      counter: result.credential.counter,
    });
    return { success: true, passkeyId };
  },
});

/**
 * Verify a finish step and burn its challenge.
 *
 * The challenge is deleted in every case where the lookup found it, also
 * when the verification fails. On a failure, the unlinked handle of the
 * ceremony is deleted too.
 */
async function consumeRegistration(
  ctx: MutationCtx,
  args: RegistrationCheckArgs,
  flow: RegistrationFlow,
): Promise<RegistrationCeremony> {
  const ceremony = await verifyRegistrationAttempt(ctx, args, flow);
  if (ceremony.userError === null) {
    await ctx.db.delete("challenges", ceremony.challengeRow._id);
  } else if (ceremony.challengeRow !== null) {
    await deleteDeadChallenge(ctx, ceremony.challengeRow);
  }
  return ceremony;
}

//------------------------------------------------------------------------------
// Verification logic for a registration attempt
//------------------------------------------------------------------------------

type RegistrationFlow =
  { kind: "newUser" } | { kind: "existingUser"; userId: string };

type RegistrationChallengeDoc = Extract<
  Doc<"challenges">,
  { kind: "registration" }
>;

type RegistrationCeremony =
  | {
      userError: FinishRegistrationUserError;
      // The challenge that the ceremony names, when the lookup found it.
      challengeRow: RegistrationChallengeDoc | null;
    }
  | {
      userError: null;
      challengeRow: RegistrationChallengeDoc;
      handle: Doc<"handles">;
      credential: VerifiedCredential;
    };

async function verifyRegistrationAttempt(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
  flow: RegistrationFlow,
): Promise<RegistrationCeremony> {
  const lookup = await lookupRegistrationChallenge(ctx, args);
  if (lookup.userError !== null) {
    return lookup;
  }
  const { challengeRow } = lookup;
  const verification = await verifyAttestation(ctx, args, challengeRow);
  if (verification.userError !== null) {
    return { userError: verification.userError, challengeRow };
  }

  const handle = await ctx.db.get("handles", challengeRow.handleId);
  if (handle === null) {
    throw new Error("The handle of the challenge does not exist.");
  }

  const startedBy = handle.userId === null ? "newUser" : "existingUser";
  if (startedBy !== flow.kind) {
    console.warn(
      `Rejected the passkey ceremony: the ceremony comes from \`${startedBy}\`, while the function for ${flow.kind} was called.`,
    );
    return { userError: { error: "PROTOCOL_ERROR" }, challengeRow };
  }

  if (flow.kind === "existingUser" && handle.userId !== flow.userId) {
    console.warn(
      "Rejecting registration of a new passkey because the passkey was created for a different user than the current user. This can happen if the user logged in and logged out during the registration process.",
    );
    return { userError: { error: "PROTOCOL_ERROR" }, challengeRow };
  }
  return {
    userError: null,
    challengeRow,
    handle,
    credential: verification.credential,
  };
}

async function lookupRegistrationChallenge(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
): Promise<
  | {
      userError: FinishRegistrationUserError;
      // The challenge that the ceremony names, when it exists. An expired
      // challenge comes back with `CHALLENGE_EXPIRED`, thus the caller can
      // erase it.
      challengeRow: RegistrationChallengeDoc | null;
    }
  | { userError: null; challengeRow: RegistrationChallengeDoc }
> {
  const PROTOCOL_ERROR = {
    userError: { error: "PROTOCOL_ERROR" },
    challengeRow: null,
  } as const;

  const { transports } = args.response.response;
  if (!transportsAreValid(transports)) {
    console.warn(
      `Rejected the passkey ceremony: the client reported transports that seem invalid. The client sent: ${JSON.stringify(transports).slice(0, 200)}.`,
    );
    return PROTOCOL_ERROR;
  }
  const clientData = okOrNull(() =>
    decodeClientDataJSON(args.response.response.clientDataJSON),
  );
  if (clientData === null) {
    console.warn(
      `Rejected the passkey ceremony: the client data JSON could not be read.`,
    );
    return PROTOCOL_ERROR;
  }
  if (clientData.type !== "webauthn.create") {
    console.warn(
      `Rejected the passkey ceremony: the client data type is ` +
        `"webauthn.get", but a registration ceremony must send ` +
        `"webauthn.create".`,
    );
    return PROTOCOL_ERROR;
  }
  if (clientData.origin !== args.expectedOrigin) {
    // We could allow this verification to be less strict in the future
    // (see the comment in `finishAuthentication`).
    console.warn(
      `Rejected the passkey ceremony: the ceremony ran at the origin ` +
        `${JSON.stringify(clientData.origin)}, but the expected origin is ` +
        `${JSON.stringify(args.expectedOrigin)}. Check that the \`origin\` of ` +
        `the sign-in method matches the page that ran the ceremony.`,
    );
    return PROTOCOL_ERROR;
  }
  if (clientData.crossOrigin === true) {
    // In the future, we could allow the user to explicitly opt out to this.
    console.warn(
      `Rejected the passkey ceremony: the ceremony ran in a cross-origin ` +
        `frame, which is not allowed.`,
    );
    return PROTOCOL_ERROR;
  }
  const challenge = okOrNull(() => isoBase64URL.toBuffer(clientData.challenge));
  if (challenge === null) {
    console.warn(
      `Rejected the passkey ceremony: the client data JSON carries no challenge.`,
    );
    return PROTOCOL_ERROR;
  }
  const challengeRow = await findChallenge(ctx, "registration", challenge);
  if (challengeRow === null || isChallengeExpired(challengeRow)) {
    return { userError: { error: "CHALLENGE_EXPIRED" }, challengeRow };
  }
  return { userError: null, challengeRow };
}

//------------------------------------------------------------------------------
// Attestation verification
//------------------------------------------------------------------------------

// The credential that a verified ceremony carries, ready to store.
type VerifiedCredential = {
  credentialId: ArrayBuffer;
  // The COSE public key, exactly as `verifyRegistrationResponse` returns it.
  publicKey: ArrayBuffer;
  counter: number;
};

/**
 * Verifies the WebAuthn attestation sent by the user.
 *
 * `@simplewebauthn/server` does the protocol work: it decodes the
 * attestation object, checks the relying party ID hash and the
 * user-presence and user-verification flags, refuses a key algorithm that
 * the ceremony never offered, and extracts the COSE public key.
 */
async function verifyAttestation(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
  challengeRow: RegistrationChallengeDoc,
): Promise<
  | { userError: FinishRegistrationUserError }
  | { userError: null; credential: VerifiedCredential }
> {
  const PROTOCOL_ERROR = { userError: { error: "PROTOCOL_ERROR" } } as const;

  // `verifyRegistrationResponse` runs all of these checks again.
  // We still perform them manually so that we can log error messages
  // that are more helpful.
  const authenticatorData = okOrNull(() => {
    const attestation = decodeAttestationObject(
      isoBase64URL.toBuffer(args.response.response.attestationObject),
    );
    return parseAuthenticatorData(attestation.get("authData"));
  });
  if (authenticatorData === null) {
    console.warn(
      `Rejected the passkey ceremony: the attestation object could not be ` +
        `read.`,
    );
    return PROTOCOL_ERROR;
  }
  if (!(await rpIdHashMatches(authenticatorData.rpIdHash, args.expectedRpId))) {
    console.warn(
      `Rejected the passkey ceremony: the authenticator data does not match ` +
        `the expected relying party ID ${JSON.stringify(args.expectedRpId)}. ` +
        `Check that the \`rpId\` of the sign-in method matches the page that ran ` +
        `the ceremony.`,
    );
    return PROTOCOL_ERROR;
  }
  if (!authenticatorData.flags.up || !authenticatorData.flags.uv) {
    // The ceremony asks for `userVerification: "required"`, thus
    // the user present/user verified flags should be set
    console.warn(
      `Rejected the passkey ceremony: the authenticator data reports no ` +
        `user presence or no user verification.`,
    );
    return PROTOCOL_ERROR;
  }
  if (authenticatorData.credentialID === undefined) {
    console.warn(
      `Rejected the passkey ceremony: the authenticator data carries no ` +
        `attested credential data.`,
    );
    return PROTOCOL_ERROR;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: toBase64URL(challengeRow.challenge),
      expectedOrigin: args.expectedOrigin,
      expectedRPID: args.expectedRpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  } catch (cause) {
    // Logging the rejection cause to help debugging, but not exposing it
    // to the client.
    console.warn(
      `Rejected the passkey ceremony: the attestation did not verify. ` +
        `If this happens for every ceremony, check that the \`rpId\` and the ` +
        `\`origin\` of the sign-in method match the page that ran it. ` +
        `${String(cause)}`,
    );
    return PROTOCOL_ERROR;
  }
  if (!verification.verified) {
    console.warn(`Rejected the passkey ceremony: the attestation is invalid.`);
    return PROTOCOL_ERROR;
  }
  const { credential } = verification.registrationInfo;

  const storedCredentialId = toArrayBuffer(
    isoBase64URL.toBuffer(credential.id),
  );
  const existing = await ctx.db
    .query("passkeys")
    .withIndex("by_credentialId", (q) =>
      q.eq("credentialId", storedCredentialId),
    )
    .first();
  if (existing !== null) {
    // A compliant client cannot cause this: authenticators make a fresh
    // random credential ID for each ceremony, and `excludeCredentials`
    // makes the authenticator refuse a duplicate for this RP. A duplicate
    // here shows a replayed or tampered registration.
    console.warn(
      `Rejected the passkey ceremony: the credential is already registered.`,
    );
    return PROTOCOL_ERROR;
  }

  return {
    userError: null,
    credential: {
      credentialId: storedCredentialId,
      publicKey: toArrayBuffer(credential.publicKey),
      counter: credential.counter,
    },
  };
}

//------------------------------------------------------------------------------
// List passkeys
//------------------------------------------------------------------------------

/**
 * List the registered passkeys of a user, for example for a settings page.
 * The function returns only public metadata. It does not return the public
 * keys or the counters.
 */
export const listPasskeys = query({
  args: { userId: v.string() },
  // TODO(nicolas) Also return `lastUsedAt` here when the field exists.
  returns: v.array(
    v.object({
      passkeyId: v.string(),
      name: v.optional(v.string()),
      credentialId: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((row) => ({
      passkeyId: row._id,
      name: row.name,
      credentialId: toBase64URL(row.credentialId),
      createdAt: row._creationTime,
    }));
  },
});

//------------------------------------------------------------------------------
// Delete passkey
//------------------------------------------------------------------------------

const deletePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: deletePasskeyUserError }),
);
type DeletePasskeyResult = Infer<typeof deletePasskeyResult>;

/**
 * Delete one passkey of `userId`.
 *
 * The `userId` parameter ensures that we always rename the passkey for the intended user.
 *
 * The function does not delete the handle of the user, not even when the
 * user has no passkeys left. A passkey that the user creates later must
 * reuse the same handle. Then an authenticator that still holds an old
 * credential keeps working, and the user does not fork across two handles.
 * Use `deleteUser` when the user is deleted permanently.
 */
export const deletePasskey = mutation({
  args: { userId: v.string(), passkeyId: v.string() },
  returns: deletePasskeyResult,
  handler: async (ctx, { userId, passkeyId }): Promise<DeletePasskeyResult> => {
    const id = ctx.db.normalizeId("passkeys", passkeyId);
    if (id === null) {
      return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
    }
    const row = await ctx.db.get("passkeys", id);
    if (row === null || row.userId !== userId) {
      return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
    }
    await ctx.db.delete("passkeys", id);
    return { success: true };
  },
});

//------------------------------------------------------------------------------
// Rename passkey
//------------------------------------------------------------------------------

const renamePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: renamePasskeyUserError }),
);
type RenamePasskeyResult = Infer<typeof renamePasskeyResult>;

/**
 * Rename one passkey of `userId`, for example from a settings page.
 *
 * The `userId` parameter ensures that we always delete the passkey for the intended user.
 * The name must be a short label (see {@link passkeyNameIsValid}).
 */
export const renamePasskey = mutation({
  args: { userId: v.string(), passkeyId: v.string(), name: v.string() },
  returns: renamePasskeyResult,
  handler: async (
    ctx,
    { userId, passkeyId, name },
  ): Promise<RenamePasskeyResult> => {
    if (!passkeyNameIsValid(name)) {
      return { success: false, userError: { error: "INVALID_NAME" } };
    }
    const id = ctx.db.normalizeId("passkeys", passkeyId);
    if (id === null) {
      return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
    }
    const row = await ctx.db.get("passkeys", id);
    if (row === null || row.userId !== userId) {
      return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
    }
    await ctx.db.patch("passkeys", id, { name });
    return { success: true };
  },
});

/**
 * Delete all the passkey data of a user: their passkeys, their handle, and
 * the authentication challenges bound to the user.
 *
 * The app calls this function when it deletes a user permanently. Do not
 * call it in other cases: without the handle, an authenticator that still
 * holds an old credential stops working (see `deletePasskey`).
 *
 * Caveat: an in-flight registration challenge that points at the handle of
 * the user survives until its TTL. That is safe: the finish step throws when
 * the handle of the challenge no longer exists, and the cleanup loop erases
 * the challenge after the TTL.
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const passkeys = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const passkey of passkeys) {
      await ctx.db.delete("passkeys", passkey._id);
    }
    const handles = await ctx.db
      .query("handles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const handle of handles) {
      await ctx.db.delete("handles", handle._id);
    }
    // Only authentication challenges carry a `userId`. Registration rows
    // have no `userId` field, so the index probe never matches them.
    const challenges = await ctx.db
      .query("challenges")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const challenge of challenges) {
      await ctx.db.delete("challenges", challenge._id);
    }
    return null;
  },
});
