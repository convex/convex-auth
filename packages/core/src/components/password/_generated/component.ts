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
      setPassword: FunctionReference<
        "mutation",
        "internal",
        { minimumLength: number; password: string; user: string },
        | { success: true }
        | {
            success: false;
            userError:
              | { error: "PASSWORD_TOO_SHORT"; minimumLength: number }
              | { error: "PASSWORD_TOO_LONG"; maximumLength: number }
              | { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" }
              | { error: "PASSWORD_TOO_COMMON" };
          },
        Name
      >;
      setPasswordForNewUser: FunctionReference<
        "mutation",
        "internal",
        { minimumLength: number; newUser: string; password: string },
        | { attestation: string; success: true }
        | {
            success: false;
            userError:
              | { error: "PASSWORD_TOO_SHORT"; minimumLength: number }
              | { error: "PASSWORD_TOO_LONG"; maximumLength: number }
              | { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" }
              | { error: "PASSWORD_TOO_COMMON" };
          },
        Name
      >;
      verifyPassword: FunctionReference<
        "mutation",
        "internal",
        { password: string; userId: string },
        | { attestation: string; success: true }
        | {
            success: false;
            userError:
              | { error: "PASSWORD_TOO_SHORT"; minimumLength: number }
              | { error: "PASSWORD_TOO_LONG"; maximumLength: number }
              | { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" }
              | { error: "INVALID_CREDENTIALS" }
              | { error: "RATE_LIMITED"; retryAfterMs: number };
          },
        Name
      >;
    };
  };
