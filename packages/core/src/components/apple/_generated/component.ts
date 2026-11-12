/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    provider: {
      createAuthorizationRequest: FunctionReference<
        "mutation",
        "internal",
        { codeVerifier: string; redirectTo: string; stateHash: string },
        { callbackUrl: string; clientId: string },
        Name
      >;
      getUserIdByAccount: FunctionReference<
        "query",
        "internal",
        { providerAccountId: string },
        string | null,
        Name
      >;
      linkAccount: FunctionReference<
        "mutation",
        "internal",
        { newUser: string; ticketCode: string },
        { attestation: string },
        Name
      >;
      redeemTicket: FunctionReference<
        "mutation",
        "internal",
        { state: string; ticketCode: string },
        | null
        | {
            attestation: string;
            kind: "existing";
            payload: string;
            providerAccountId: string;
          }
        | { kind: "new"; payload: string; providerAccountId: string },
        Name
      >;
    };
  };
