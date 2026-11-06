/**
 * The required table fields for OAuth components. A component with extra
 * fields spreads these into its own tables.
 *
 * @module
 */
import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * An authorization request is created when sign-in starts, and the
 * provider's callback claims it.
 */
export const authorizationRequestFields = {
  /** Hash of the server-minted state. The raw value is never stored. */
  stateHash: v.string(),
  /** Post-login destination, validated against allowed redirects at sign-in. */
  redirectTo: v.string(),
  /** The OAuth `redirect_uri`. */
  callbackUrl: v.string(),
  /**
   * The raw PKCE code verifier, sent to the provider at code exchange. Every
   * provider gets a challenge, because a provider without PKCE support
   * ignores the parameters.
   */
  codeVerifier: v.string(),
  /** The callback rejects requests older than this. */
  expiresAt: v.number(),
};

/**
 * A ticket is proof that the provider authenticated the user. The callback
 * creates it after the code exchange. A caller redeems it once by presenting
 * the raw ticket code and the original state. No account, user, or session is
 * created until then.
 */
export const ticketFields = {
  /**
   * Carried over from the authorization request. Redemption re-checks the
   * caller-presented state against it, binding completion to the browser
   * or server that initiated the flow.
   */
  stateHash: v.string(),
  /**
   * sha256 of the server-minted ticket code. The raw value appears only
   * in the callback redirect URL and is never stored.
   */
  ticketCodeHash: v.string(),
  /** Redemption rejects tickets past this. Set at mint. */
  expiresAt: v.number(),
  /**
   * The identity the provider attested, as JSON, AES-GCM encrypted with a key
   * derived from the raw ticket code. The raw code is never stored, so
   * database access alone cannot read the payload, and provider-chosen JSON
   * keys never become Convex field names.
   */
  encryptedPayload: v.string(),
};

export const authorizationRequestsTable = defineTable(
  authorizationRequestFields,
).index("stateHash", ["stateHash"]);

export const ticketsTable = defineTable(ticketFields).index("ticketCodeHash", [
  "ticketCodeHash",
]);

/**
 * An account maps the identity the provider attested (its `sub`, or the
 * profile `id` the provider's mapping produced) to the app user it belongs
 * to. The first redemption of an identity creates it, after the core has
 * minted the app user; every later redemption resolves it and signs that
 * user in.
 */
export const accountFields = {
  /** The provider-scoped account id: the profile mapping's `id`. */
  providerAccountId: v.string(),
  /** The opaque app user id the app's `createUser` callback returned. */
  userId: v.string(),
};

export const accountsTable = defineTable(accountFields)
  .index("providerAccountId", ["providerAccountId"])
  .index("userId", ["userId"]);
