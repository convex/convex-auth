/**
 * The database work behind every OAuth component's `provider.ts`.
 *
 * An OAuth flow needs two short-lived documents: an authorization request,
 * written when sign-in starts and claimed by the provider callback, and a
 * ticket, minted by the callback and redeemed by the app. Each OAuth
 * component also keeps a durable account per identity, connecting a provider
 * account id to an app user id. Every OAuth component keeps the same tables,
 * so the reads and writes live here, and each component's `provider.ts`
 * supplies its own argument validators and document types.
 *
 * @module
 */
import type {
  GenericDatabaseReader,
  GenericDataModel,
  GenericMutationCtx,
  WithoutSystemFields,
} from "convex/server";
import type { GenericId, ObjectType } from "convex/values";
import { CALLBACK_PATH } from "./constants.ts";
import type {
  accountFields,
  authorizationRequestFields,
  ticketFields,
} from "./schema.ts";

/** How long an authorization request stays claimable by the callback. */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000; // 10m

/** How long a minted ticket stays redeemable. Redemption is normally the
 * page load right after the callback redirect, so this only needs slack
 * for slow devices and networks. */
export const TICKET_TTL_MS = 2 * 60 * 1000;

/**
 * The ctx these take. A component's own generated `MutationCtx` cannot be the
 * type here: `GenericDatabaseWriter`'s members are methods, which TypeScript
 * compares bivariantly, so one component's ctx type would be accepted for
 * every other component while asserting a schema they do not have. This wide
 * ctx says what is true, which is that this code does not know the data model.
 * The document types below are what carry the real contract.
 */
type MutationCtx = GenericMutationCtx<GenericDataModel>;
/**
 * The ctx the read helpers take, from either a query or a mutation. It names
 * only `db.query` because a component's own query ctx is not assignable to
 * `GenericQueryCtx<GenericDataModel>`.
 */
type QueryCtx = { db: Pick<GenericDatabaseReader<GenericDataModel>, "query"> };

/** What this code requires from an authorization request document. */
export type AuthorizationRequestContract = ObjectType<
  typeof authorizationRequestFields
>;

/** What this code requires from a ticket document. */
export type TicketContract = ObjectType<typeof ticketFields>;

/** What this code requires from an account document. */
export type AccountContract = ObjectType<typeof accountFields>;

/**
 * Record an in-flight authorization request and return the callback URL it
 * was recorded under. Called by the app-side `startSignIn` before it
 * redirects the user to the provider; the provider callback later claims the
 * request by state hash.
 *
 * The caller writes out `Doc` as its own generated document type, e.g.
 * `insertAuthorizationRequest<Doc<"authorizationRequests">>(ctx, args)`.
 */
export async function insertAuthorizationRequest<
  Doc extends AuthorizationRequestContract,
>(
  ctx: MutationCtx,
  fields: Omit<WithoutSystemFields<Doc>, "callbackUrl" | "expiresAt">,
): Promise<{ callbackUrl: string }> {
  // System env vars are only visible inside components on backends with
  // convex/convex-backend@64c163a (July 2026); cloud always has it,
  // self-hosted may not.
  // TODO: remove this check when no longer needed.
  const siteUrl = process.env.CONVEX_SITE_URL;
  if (siteUrl === undefined) {
    throw new Error(
      "CONVEX_SITE_URL is not visible inside the oauth component. " +
        "This requires a Convex backend with system env vars in component " +
        "functions.",
    );
  }
  const callbackUrl = `${siteUrl}${CALLBACK_PATH}`;
  await ctx.db.insert("authorizationRequests", {
    ...fields,
    callbackUrl,
    expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
  });
  return { callbackUrl };
}

/**
 * The second half of the OAuth flow: after the user authenticates, the
 * provider redirects back to the component's HTTP callback route, which calls
 * this to claim the matching request by state hash.
 *
 * Finding, deleting, and checking the deadline happen in one transaction, so
 * a replayed or raced callback finds nothing. An expired request gives back
 * only where the user came from, because that is all the callback can still
 * use: it would rather send them back to the app than strand them.
 *
 * The caller writes out `Doc` as its own generated document type, e.g.
 * `claimAuthorizationRequest<Doc<"authorizationRequests">>(ctx, hash)`.
 */
export async function claimAuthorizationRequest<
  Doc extends AuthorizationRequestContract,
>(
  ctx: MutationCtx,
  stateHash: string,
): Promise<
  null | { expired: true; redirectTo: string } | { expired: false; doc: Doc }
> {
  // The wide ctx types this as a bare document, so the shape has to be
  // asserted. The fields are not a guess, though, because every caller has
  // to prove its `Doc` has them. Only the `_id` table brand goes unproven,
  // and it came from a query on that table.
  const request = (await ctx.db
    .query("authorizationRequests")
    .withIndex("stateHash", (q) => q.eq("stateHash", stateHash))
    .unique()) as (Doc & { _id: GenericId<"authorizationRequests"> }) | null;
  if (request === null) {
    return null;
  }
  await ctx.db.delete("authorizationRequests", request._id);
  if (request.expiresAt < Date.now()) {
    return { expired: true, redirectTo: request.redirectTo };
  }
  return { expired: false, doc: request };
}

/**
 * Store a one-time redeemable ticket after a successful code exchange. The
 * caller (the callback) holds the raw ticket code; only its hash is stored,
 * and the identity payload arrives already encrypted with a key derived from
 * that code.
 *
 * The caller writes out `Doc` as its own generated document type, e.g.
 * `insertTicket<Doc<"tickets">>(ctx, args)`.
 */
export async function insertTicket<Doc extends TicketContract>(
  ctx: MutationCtx,
  fields: Omit<WithoutSystemFields<Doc>, "expiresAt">,
): Promise<null> {
  await ctx.db.insert("tickets", {
    ...fields,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return null;
}

/**
 * Claim a ticket by ticket code hash: find, check, delete, and return it in
 * one transaction, so a replayed or raced redemption finds nothing.
 *
 * The caller must also present the hash of the state minted at sign-in, which
 * binds redemption to the client that initiated the flow. `match` is an extra
 * check over the stored ticket, for a component that keeps more on it and
 * wants those fields to have to match too.
 *
 * The caller writes out `Doc` as its own generated document type, e.g.
 * `claimTicket<Doc<"tickets">>(ctx, args)`.
 */
export async function claimTicket<Doc extends TicketContract>(
  ctx: MutationCtx,
  args: {
    ticketCodeHash: string;
    stateHash: string;
    match?: (ticket: Doc) => boolean;
  },
): Promise<{ encryptedPayload: string } | null> {
  // The same assertion as in claimAuthorizationRequest, for the same reason.
  const ticket = (await ctx.db
    .query("tickets")
    .withIndex("ticketCodeHash", (q) =>
      q.eq("ticketCodeHash", args.ticketCodeHash),
    )
    .unique()) as (Doc & { _id: GenericId<"tickets"> }) | null;
  if (ticket === null) {
    return null;
  }
  if (ticket.expiresAt < Date.now()) {
    await ctx.db.delete("tickets", ticket._id);
    return null;
  }
  if (ticket.stateHash !== args.stateHash) {
    return null;
  }
  if (args.match !== undefined && !args.match(ticket)) {
    return null;
  }
  await ctx.db.delete("tickets", ticket._id);
  return { encryptedPayload: ticket.encryptedPayload };
}

/**
 * Get the app user id connected to a given provider account id, or `null`
 * if there is none.
 *
 * The caller writes out `Doc` as its own generated document type, e.g.
 * `findAccountUserId<Doc<"accounts">>(ctx, args)`.
 */
export async function findAccountUserId<Doc extends AccountContract>(
  ctx: QueryCtx,
  args: { providerAccountId: string },
): Promise<string | null> {
  // The same assertion as in claimAuthorizationRequest, for the same reason.
  const account = (await ctx.db
    .query("accounts")
    .withIndex("providerAccountId", (q) =>
      q.eq("providerAccountId", args.providerAccountId),
    )
    .unique()) as Doc | null;
  return account?.userId ?? null;
}

/**
 * Create an account connecting `providerAccountId` to `userId`. Throws if
 * that provider account id already has an account, since it must never map
 * to two app users.
 *
 * The caller writes out `Doc` as its own generated document type, e.g.
 * `insertAccount<Doc<"accounts">>(ctx, args)`.
 */
export async function insertAccount<Doc extends AccountContract>(
  ctx: MutationCtx,
  { providerAccountId, userId }: AccountContract,
): Promise<null> {
  const existing = await findAccountUserId<Doc>(ctx, { providerAccountId });
  if (existing !== null) {
    throw new Error(
      `Invariant violation: an account for provider account id ` +
        `${JSON.stringify(providerAccountId)} already exists`,
    );
  }
  await ctx.db.insert("accounts", { providerAccountId, userId });
  return null;
}
