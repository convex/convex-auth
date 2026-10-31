/**
 * The registered mutations behind a built-in provider's `provider.ts`.
 *
 * Each built-in provider has its own component with two tables and four
 * mutations. The four create and claim an authorization request, and create
 * and claim a ticket.
 * The database work lives in `dbHelpers.ts`. This module adds the
 * registration, meaning the argument and return validators and the functions
 * that wrap them.
 *
 * @module
 */
import type {
  GenericDataModel,
  IdField,
  MutationBuilder,
  SystemFields,
} from "convex/server";
import { v } from "convex/values";
import * as dbHelpers from "./dbHelpers.ts";
import type {
  AuthorizationRequestContract,
  TicketContract,
} from "./dbHelpers.ts";
import { authorizationRequestFields, ticketFields } from "./schema.ts";

type SharedRequestDocument = AuthorizationRequestContract &
  IdField<"authorizationRequests"> &
  SystemFields;

type SharedTicketDocument = TicketContract & IdField<"tickets"> & SystemFields;

/**
 * Gives a compile time error at the {@link buildProviderFunctions} call when
 * a component's table schema doesn't match the shared fields. The mutations
 * below only write the shared fields, so a table with any other fields is
 * incompatible.
 */
type OnlyTheFieldsOf<Doc, Shared> = Shared &
  Record<Exclude<keyof Doc, keyof Shared>, never>;

// The validators below come off the schema fields, so a mutation and the
// table it writes cannot disagree about what a request or a ticket holds.

/**
 * `createAuthorizationRequest` takes the request without the deadline, which
 * the component fills in itself. The callback URL is optional: without it,
 * the component uses its own callback route under `CONVEX_SITE_URL`.
 */
const createRequestArgs = v
  .object(authorizationRequestFields)
  .omit("callbackUrl", "expiresAt")
  .extend({ callbackUrl: v.optional(v.string()) });

/** The fields of a claimed request that is still live. */
const claimedRequestFields = v
  .object(authorizationRequestFields)
  .omit("expiresAt");

const claimRequestResult = v.union(
  v.null(),
  v.object({ expired: v.literal(true), redirectTo: v.string() }),
  v.object({ expired: v.literal(false), ...claimedRequestFields.fields }),
);

/** `createTicket` takes the ticket without the deadline, which it sets itself. */
const createTicketArgs = v.object(ticketFields).omit("expiresAt");

/**
 * Build the four mutations a built-in provider's component registers. The
 * component's `provider.ts` destructures the result and exports the four
 * under their own names, which is what Convex registers them as.
 *
 * The caller has to pass its own two document types, e.g.
 * `buildProviderFunctions<Doc<"authorizationRequests">, Doc<"tickets">>({...})`.
 * {@link OnlyTheFieldsOf} checks those types, and a call without them compiles
 * with no check. A component with extra table fields writes its own four
 * mutations.
 */
export function buildProviderFunctions<
  RequestDoc extends OnlyTheFieldsOf<RequestDoc, SharedRequestDocument>,
  TicketDoc extends OnlyTheFieldsOf<TicketDoc, SharedTicketDocument>,
>(options: {
  mutation: MutationBuilder<GenericDataModel, "public">;
  internalMutation: MutationBuilder<GenericDataModel, "internal">;
  /**
   * Read the `CLIENT_ID` bound to this component instance. It is a function
   * so the value is read when the mutation runs, not when the module loads.
   */
  clientId: () => string;
}) {
  const createAuthorizationRequest = options.mutation({
    args: createRequestArgs,
    returns: v.object({ clientId: v.string(), callbackUrl: v.string() }),
    handler: async (ctx, args) => {
      const { callbackUrl } =
        await dbHelpers.insertAuthorizationRequest<SharedRequestDocument>(
          ctx,
          args,
        );
      return { clientId: options.clientId(), callbackUrl };
    },
  });

  const claimAuthorizationRequest = options.internalMutation({
    args: { stateHash: v.string() },
    returns: claimRequestResult,
    handler: async (ctx, args) => {
      const claimed =
        await dbHelpers.claimAuthorizationRequest<SharedRequestDocument>(
          ctx,
          args.stateHash,
        );
      if (claimed === null) {
        return null;
      }
      if (claimed.expired) {
        return { expired: true as const, redirectTo: claimed.redirectTo };
      }
      return {
        expired: false as const,
        stateHash: claimed.doc.stateHash,
        redirectTo: claimed.doc.redirectTo,
        callbackUrl: claimed.doc.callbackUrl,
        codeVerifier: claimed.doc.codeVerifier,
      };
    },
  });

  const createTicket = options.internalMutation({
    args: createTicketArgs,
    returns: v.null(),
    handler: async (ctx, args) =>
      await dbHelpers.insertTicket<SharedTicketDocument>(ctx, args),
  });

  const claimTicket = options.mutation({
    args: {
      ticketCodeHash: v.string(),
      stateHash: v.string(),
    },
    returns: v.union(v.null(), v.object({ encryptedPayload: v.string() })),
    handler: async (ctx, args) =>
      await dbHelpers.claimTicket<SharedTicketDocument>(ctx, args),
  });

  return {
    createAuthorizationRequest,
    claimAuthorizationRequest,
    createTicket,
    claimTicket,
  };
}
