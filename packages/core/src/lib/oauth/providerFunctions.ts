/**
 * The registered mutations behind a built-in provider's `provider.ts`.
 *
 * Each built-in provider has its own component with three tables and six
 * functions. Four mutations create and claim an authorization request, and
 * create and claim a ticket; a query resolves an account to its app user, and
 * a mutation creates one.
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
  QueryBuilder,
  SystemFields,
} from "convex/server";
import { v } from "convex/values";
import * as dbHelpers from "./dbHelpers.ts";
import type {
  AccountContract,
  AuthorizationRequestContract,
  TicketContract,
} from "./dbHelpers.ts";
import {
  accountFields,
  authorizationRequestFields,
  ticketFields,
} from "./schema.ts";

type SharedRequestDocument = AuthorizationRequestContract &
  IdField<"authorizationRequests"> &
  SystemFields;

type SharedTicketDocument = TicketContract & IdField<"tickets"> & SystemFields;

type SharedAccountDocument = AccountContract &
  IdField<"accounts"> &
  SystemFields;

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
 * `createAuthorizationRequest` takes the request without the callback URL and
 * the deadline, which the component fills in itself.
 */
const createRequestArgs = v
  .object(authorizationRequestFields)
  .omit("callbackUrl", "expiresAt");

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
 * Build the six functions a built-in provider's component registers. The
 * component's `provider.ts` destructures the result and exports the six
 * under their own names, which is what Convex registers them as.
 *
 * The caller has to pass its own three document types, e.g.
 * `buildProviderFunctions<Doc<"authorizationRequests">, Doc<"tickets">, Doc<"accounts">>({...})`.
 * {@link OnlyTheFieldsOf} checks those types, and a call without them compiles
 * with no check. A component with extra table fields writes its own
 * functions.
 */
export function buildProviderFunctions<
  RequestDoc extends OnlyTheFieldsOf<RequestDoc, SharedRequestDocument>,
  TicketDoc extends OnlyTheFieldsOf<TicketDoc, SharedTicketDocument>,
  AccountDoc extends OnlyTheFieldsOf<AccountDoc, SharedAccountDocument>,
>(options: {
  /**
   * The component's own `query` builder. A `QueryBuilder<GenericDataModel>`
   * would not accept it: a query ctx is not assignable across data models
   * the way a mutation ctx is (the writer's members are methods, which
   * TypeScript compares bivariantly; the reader's are not all). The
   * handler below only passes the ctx on to the data-model-agnostic helper.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: QueryBuilder<any, "public">;
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

  const getUserIdByAccount = options.query({
    args: { providerAccountId: v.string() },
    returns: v.union(v.string(), v.null()),
    handler: async (ctx, args) =>
      await dbHelpers.findAccountUserId<SharedAccountDocument>(ctx, args),
  });

  const createAccount = options.mutation({
    args: accountFields,
    returns: v.null(),
    handler: async (ctx, args) =>
      await dbHelpers.insertAccount<SharedAccountDocument>(
        ctx,
        { providerAccountId: args.providerAccountId },
        args.userId,
      ),
  });

  return {
    createAuthorizationRequest,
    claimAuthorizationRequest,
    createTicket,
    claimTicket,
    getUserIdByAccount,
    createAccount,
  };
}
