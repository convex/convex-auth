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
    public: {
      deleteUsername: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        { deleted: boolean },
        Name
      >;
      getUserIdByUsername: FunctionReference<
        "query",
        "internal",
        { username: string },
        string | null,
        Name
      >;
      getUsername: FunctionReference<
        "query",
        "internal",
        { userId: string },
        string | null,
        Name
      >;
      setUsername: FunctionReference<
        "mutation",
        "internal",
        { userId: string; username: string },
        | { previousUsername: string | null; success: true }
        | {
            success: false;
            userError:
              | { error: "USERNAME_TOO_SHORT"; minimumLength: number }
              | { error: "USERNAME_TOO_LONG"; maximumLength: number }
              | { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" }
              | { error: "USERNAME_HAS_INVALID_CHARACTERS" }
              | { error: "USERNAME_TAKEN" };
          },
        Name
      >;
    };
  };
