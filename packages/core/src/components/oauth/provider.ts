import { v } from "convex/values";
import { env, internalMutation, mutation, query } from "./_generated/server.ts";
import type { Doc } from "./_generated/dataModel.ts";
import * as dbHelpers from "../../lib/oauth/dbHelpers.ts";
import { accountFields } from "../../lib/oauth/schema.ts";

/**
 * Record an in-flight authorization request. Called by the app-side
 * `signIn` before it redirects the user to the provider; the provider
 * callback later claims the request by state hash.
 *
 * Returns the provider's `CLIENT_ID` and the callback URL, which the caller
 * needs for the authorization URL.
 *
 * DANGER: the component does not validate `redirectTo`, and the callback
 * sends the one-time ticket code there. The method's `startSignIn` checks it
 * against `allowedRedirectOrigins` first; a caller that skips the check lets
 * an attacker get a victim's ticket code, and sign in as the victim.
 *
 * TODO: validate `redirectTo` in the component, e.g. against allowed origins
 * given in the component's configuration.
 */
export const _internal_dangerous_createAuthorizationRequest = mutation({
  args: {
    providerName: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    codeVerifier: v.string(),
    tokenEndpoint: v.string(),
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    issuers: v.optional(v.array(v.string())),
  },
  returns: v.object({
    clientId: v.string(),
    callbackUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    const { callbackUrl } = await dbHelpers.insertAuthorizationRequest<
      Doc<"authorizationRequests">
    >(ctx, args);
    return { clientId: env.CLIENT_ID, callbackUrl };
  },
});

/**
 * Claim the authorization request the provider's callback is answering.
 *
 * If the request record has expired, it is deleted and its `redirectTo` is
 * returned so the callback can send the user back to the app instead of
 * stranding them on an error page.
 */
export const claimAuthorizationRequest = internalMutation({
  args: {
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      expired: v.literal(true),
      redirectTo: v.string(),
    }),
    v.object({
      expired: v.literal(false),
      providerName: v.string(),
      stateHash: v.string(),
      redirectTo: v.string(),
      callbackUrl: v.string(),
      codeVerifier: v.string(),
      tokenEndpoint: v.string(),
      userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
      issuers: v.optional(v.array(v.string())),
    }),
  ),
  handler: async (ctx, args) => {
    const claimed = await dbHelpers.claimAuthorizationRequest<
      Doc<"authorizationRequests">
    >(ctx, args.stateHash);
    if (claimed === null) {
      return null;
    }
    if (claimed.expired) {
      return { expired: true as const, redirectTo: claimed.redirectTo };
    }
    const { doc } = claimed;
    return {
      expired: false as const,
      providerName: doc.providerName,
      stateHash: doc.stateHash,
      redirectTo: doc.redirectTo,
      callbackUrl: doc.callbackUrl,
      codeVerifier: doc.codeVerifier,
      tokenEndpoint: doc.tokenEndpoint,
      userInfoEndpoints: doc.userInfoEndpoints,
      issuers: doc.issuers,
    };
  },
});

/**
 * Store a one-time redeemable ticket after a successful code exchange. The
 * caller (the callback) holds the raw ticket code; only its hash is
 * stored, and the identity payload arrives already encrypted with a key
 * derived from that code.
 */
export const createTicket = internalMutation({
  args: {
    providerName: v.string(),
    stateHash: v.string(),
    ticketCodeHash: v.string(),
    encryptedPayload: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) =>
    await dbHelpers.insertTicket<Doc<"tickets">>(ctx, args),
});

/**
 * Claim a ticket. The ticket code hash, state hash, and provider name must
 * all match the stored ticket, so a misconfigured or renamed provider
 * instance can't redeem a ticket into the wrong account namespace.
 */
export const claimTicket = mutation({
  args: {
    providerName: v.string(),
    ticketCodeHash: v.string(),
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      encryptedPayload: v.string(),
    }),
  ),
  handler: async (ctx, args) =>
    await dbHelpers.claimTicket<Doc<"tickets">>(ctx, {
      ticketCodeHash: args.ticketCodeHash,
      stateHash: args.stateHash,
      match: (ticket) => ticket.providerName === args.providerName,
    }),
});

/**
 * Get the app user id connected to a given provider account id, or `null`
 * if there is none.
 */
export const getUserIdByAccount = query({
  args: { providerAccountId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) =>
    await dbHelpers.findAccountUserId<Doc<"accounts">>(ctx, args),
});

/**
 * Create an account connecting a provider account id to an app user id.
 * Throws if that provider account id already has one.
 *
 * DANGER: an unverified `userId` or `providerAccountId` lets an attacker
 * connect their provider account to another user's account.
 *
 * TODO: ensure that the user ID is the current user.
 */
export const _internal_dangerous_createAccount = mutation({
  args: accountFields,
  returns: v.null(),
  handler: async (ctx, args) =>
    await dbHelpers.insertAccount<Doc<"accounts">>(ctx, args),
});
