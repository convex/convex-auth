import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row for each passkey credential. The component only sees an opaque
  // app `userId` string. It does not see usernames or email addresses.
  passkeys: defineTable({
    userId: v.string(),
    // A label that the user sets for this passkey. An app can show it in
    // a passkey list (for example, "MacBook Touch ID").
    name: v.optional(v.string()),
    // The raw credential ID bytes (the WebAuthn `rawId`).
    credentialId: v.bytes(),
    // The COSE public key (this contains the key, algorithm and curve).
    publicKey: v.bytes(),
    // The signature counter. The value is 0 if the authenticator does not
    // use a counter. When the authenticator supports the counter, it is
    // expected to be always increasing. This component doesn’t enforce it,
    // but in theory this property could be used to detect cloned passkeys.
    counter: v.number(),
    // The transports that the browser reported for this credential, for
    // example "internal", "usb", or "hybrid". The field is not set when
    // the browser did not report them. The values are plain strings,
    // because the WebAuthn spec lets new transports appear.
    // https://www.w3.org/TR/webauthn-3/#enum-transport
    transports: v.optional(v.array(v.string())),
  })
    .index("by_credentialId", ["credentialId"])
    .index("by_userId", ["userId"]),

  // The WebAuthn user handle of each user. The handle is the `user.id` that
  // the authenticator stores with a discoverable credential. A user has a
  // maximum of ONE handle: the registration code reuses an existing handle.
  //
  // The handle exists because the app user id cannot be the WebAuthn user
  // handle in the auth flows where the user is created transactionally with
  // the passkey registration: the user row does not exist yet when
  // the registration ceremony starts. The handle is created first, and
  // `_internal_dangerous_finishRegistrationForNewUser` links it to the user.
  handles: defineTable({
    // 64 random bytes (the WebAuthn maximum length for `user.id`).
    handle: v.bytes(),
    // The app user that owns the handle, or `null` until the account exists.
    userId: v.union(v.string(), v.null()),
  })
    .index("by_userId", ["userId"])
    // Used to make sure that a new handle does not collide with an existing
    // one. A collision of 64 random bytes is not expected to happen, but the
    // registration code checks for it because a shared handle might cause
    // authenticators to delete passkeys incorrectly.
    .index("by_handle", ["handle"]),

  // The WebAuthn challenges that are active. Each challenge is for one use
  // only: the finish step deletes it. A challenge expires a fixed time after
  // its creation (see CHALLENGE_TTL_MS), thus `_creationTime` is the age of
  // the challenge and the built-in `by_creation_time` index gives the
  // background cleanup loop (see cleanup.ts) the oldest challenges first.
  challenges: defineTable(
    v.union(
      v.object({
        kind: v.literal("registration"),
        challenge: v.bytes(), // 32 random bytes
        // The handle that this ceremony registers a credential for.
        handleId: v.id("handles"),
      }),
      v.object({
        kind: v.literal("authentication"),
        challenge: v.bytes(),
        // The flow that this challenge is for, for example a sign-in or a
        // re-authentication before a change of a setting. The value is
        // opaque to the component. The start step and the finish step
        // must give the same purpose, thus an assertion for one flow
        // cannot complete a different flow. A different purpose
        // at the finish step is a protocol violation.
        // The purpose string is expected to be a constant string identifying
        // a specific flow, and should not contain dynamic information.
        purpose: v.string(),
        // The user that the challenge is for, if the app knows the user.
        // The field is not set for discoverable-credential ceremonies. In
        // that flow, the assertion identifies the user.
        userId: v.optional(v.string()),
      }),
    ),
  )
    .index("by_challenge", ["challenge"])
    // Used by `deleteUser` to erase the authentication challenges that are
    // bound to a user. Registration rows have no `userId` field, so a probe
    // with a user ID string never matches them.
    .index("by_userId", ["userId"]),
});
