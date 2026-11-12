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
    enrollment: {
      confirmTotp: FunctionReference<
        "mutation",
        "internal",
        { code: string; currentUser: string },
        | { backupCodes?: Array<string>; success: true; totpId: string }
        | {
            success: false;
            userError:
              | { error: "INCORRECT_CODE" }
              | { error: "NO_PENDING_ENROLLMENT" }
              | { error: "TOO_MANY_TOTPS" };
          },
        Name
      >;
      createTotp: FunctionReference<
        "mutation",
        "internal",
        {
          accountDisplayName: string;
          currentUser: string;
          issuerDisplayName: string;
        },
        { otpauthUri: string; secret: string },
        Name
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { userId: string },
        { enabled: boolean; remainingBackupCodes: number },
        Name
      >;
      listTotps: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{ createdAt: number; totpId: string }>,
        Name
      >;
    };
  };
