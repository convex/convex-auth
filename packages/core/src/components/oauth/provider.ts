import { v } from "convex/values";
import { env, internalMutation, mutation, query } from "./_generated/server.ts";
import type { Doc } from "./_generated/dataModel.ts";
import * as dbHelpers from "../../lib/oauth/dbHelpers.ts";
import { providerConfig } from "./config.ts";

/**
 * Record an in-flight authorization request. Called by the app-side
 * `signIn` before it redirects the user to the provider; the provider
 * callback later claims the request by state hash.
 *
 * Returns the provider's `CLIENT_ID` and the callback URL, which the caller
 * needs for the authorization URL.
 */
export const createAuthorizationRequest = mutation({
  args: {
    providerName: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    codeVerifier: v.string(),
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

const redeemTicketResult = v.union(
  v.null(),
  v.object({
    kind: v.literal("existing"),
    payload: v.string(),
    providerAccountId: v.string(),
    attestation: v.string(),
  }),
  v.object({
    kind: v.literal("new"),
    payload: v.string(),
    providerAccountId: v.string(),
  }),
);

/**
 * Redeem a ticket: claim it, derive the provider account id from the
 * identity that the provider attested (with `ACCOUNT_ID_FIELD`), and attest
 * the user of the account. See `dbHelpers.redeemTicket`. The ticket code,
 * the state, and the provider name must all match the stored ticket, so a
 * misconfigured or renamed provider instance can't redeem a ticket into the
 * wrong account namespace.
 */
export const redeemTicket = mutation({
  args: {
    providerName: v.string(),
    ticketCode: v.string(),
    state: v.string(),
  },
  returns: redeemTicketResult,
  handler: async (ctx, args) =>
    await dbHelpers.redeemTicket<Doc<"tickets">, Doc<"accounts">>(ctx, {
      ticketCode: args.ticketCode,
      state: args.state,
      // Read the settings only for a ticket that redeems.
      accountId: (payload) => providerConfig().accountId(payload),
      match: (ticket) => ticket.providerName === args.providerName,
    }),
});

/**
 * Connect the identity of a redeemed ticket to a new user, and attest the
 * user. See `dbHelpers.linkAccount`.
 */
export const linkAccount = mutation({
  args: { ticketCode: v.string(), newUser: v.string() },
  returns: v.object({ attestation: v.string() }),
  handler: async (ctx, args) =>
    await dbHelpers.linkAccount<Doc<"tickets">, Doc<"accounts">>(ctx, args),
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
