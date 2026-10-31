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
    connections: {
      get: FunctionReference<
        "query",
        "internal",
        { id: string },
        null | {
          connectionType: string;
          id: string;
          name?: string;
          organizationId?: string;
          state: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { organizationId: string },
        Array<{
          connectionType: string;
          id: string;
          name?: string;
          organizationId?: string;
          state: string;
        }>,
        Name
      >;
    };
    directories: {
      get: FunctionReference<
        "query",
        "internal",
        { id: string },
        null | {
          id: string;
          name: string;
          organizationId?: string;
          state: string;
          type: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { organizationId: string },
        Array<{
          id: string;
          name: string;
          organizationId?: string;
          state: string;
          type: string;
        }>,
        Name
      >;
    };
    directoryGroups: {
      get: FunctionReference<
        "query",
        "internal",
        { id: string },
        null | {
          directoryId: string;
          id: string;
          idpId?: string;
          name: string;
          organizationId?: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          directory?: string;
          organization?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            directoryId: string;
            id: string;
            idpId?: string;
            name: string;
            organizationId?: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
    directoryUsers: {
      get: FunctionReference<
        "query",
        "internal",
        { id: string },
        null | {
          directoryId: string;
          email?: string;
          firstName?: string;
          id: string;
          idpId: string;
          lastName?: string;
          organizationId?: string;
          role?: { slug: string };
          roles?: Array<{ slug: string }>;
          state: string;
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          directory?: string;
          email?: string;
          idpId?: string;
          organization?: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            directoryId: string;
            email?: string;
            firstName?: string;
            id: string;
            idpId: string;
            lastName?: string;
            organizationId?: string;
            role?: { slug: string };
            roles?: Array<{ slug: string }>;
            state: string;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
    organizationDomains: {
      get: FunctionReference<
        "query",
        "internal",
        { domain: string },
        null | {
          connection: {
            connectionType: string;
            id: string;
            name?: string;
            organizationId?: string;
            state: string;
          };
          organization: { externalId?: string; id: string; name: string };
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { organizationId: string },
        Array<{
          domain: string;
          id: string;
          organizationId: string;
          state: string;
        }>,
        Name
      >;
    };
    organizations: {
      get: FunctionReference<
        "query",
        "internal",
        { id: string },
        null | { externalId?: string; id: string; name: string },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{ externalId?: string; id: string; name: string }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
    portal: {
      generateLink: FunctionReference<
        "action",
        "internal",
        {
          intent:
            "sso" | "dsync" | "domain_verification" | "certificate_renewal";
          organizationId: string;
          returnUrl?: string;
          successUrl?: string;
        },
        { link: string },
        Name
      >;
    };
    provider: {
      claimTicket: FunctionReference<
        "mutation",
        "internal",
        { stateHash: string; ticketCodeHash: string },
        null | { encryptedPayload: string },
        Name
      >;
      createAuthorizationRequest: FunctionReference<
        "mutation",
        "internal",
        {
          callbackUrl?: string;
          codeVerifier: string;
          redirectTo: string;
          stateHash: string;
        },
        { callbackUrl: string; clientId: string },
        Name
      >;
    };
    reconcile: {
      start: FunctionReference<"mutation", "internal", {}, null, Name>;
    };
    webhook: {
      register: FunctionReference<
        "action",
        "internal",
        { onEvent: string },
        { created: boolean; endpointId: string },
        Name
      >;
      unregister: FunctionReference<
        "action",
        "internal",
        {},
        { deleted: boolean },
        Name
      >;
    };
  };
