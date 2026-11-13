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
    native: {
      _internal_dangerous_exchangeIdToken: FunctionReference<
        "action",
        "internal",
        { audiences: Array<string>; idToken: string; nonce?: string },
        | { code: string; state: string; status: "exchanged" }
        | { status: "error"; userError: { error: "INVALID_ID_TOKEN" } },
        Name
      >;
    };
    provider: {
      _internal_dangerous_createAccount: FunctionReference<
        "mutation",
        "internal",
        { providerAccountId: string; userId: string },
        null,
        Name
      >;
      _internal_dangerous_createAuthorizationRequest: FunctionReference<
        "mutation",
        "internal",
        { codeVerifier: string; redirectTo: string; stateHash: string },
        { callbackUrl: string; clientId: string },
        Name
      >;
      claimTicket: FunctionReference<
        "mutation",
        "internal",
        { stateHash: string; ticketCodeHash: string },
        null | { encryptedPayload: string },
        Name
      >;
      getUserIdByAccount: FunctionReference<
        "query",
        "internal",
        { providerAccountId: string },
        string | null,
        Name
      >;
    };
  };
