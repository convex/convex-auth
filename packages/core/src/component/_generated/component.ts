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
    init: {
      configure: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          refreshTokenTtlSeconds?: number;
          providers?: Array<{
            name: string;
            createUser: import("convex/server").FunctionHandle_future<
              "mutation",
              { provider: { name: string; accountId: string; profile: any } },
              string
            >;
            onSignIn?: import("convex/server").FunctionHandle_future<
              "mutation",
              {
                provider: { name: string; accountId: string; profile: any };
                userId: string;
              },
              null
            >;
          }>;
        },
        null,
        Name
      >;
    };
    public: {
      getUserIdByAccount: FunctionReference<
        "query",
        "internal",
        { provider: string; providerAccountId: string },
        string | null,
        Name
      >;
      refresh: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          issuer: string;
          refreshToken: string;
          refreshTokenTtlSeconds?: number;
        },
        | {
            kind: "rotated";
            tokens: {
              accessToken: string;
              accessTokenExpiresAt: number;
              refreshToken: string;
              refreshTokenExpiresAt: number;
              userId: string;
            };
          }
        | { kind: "noSession" },
        Name
      >;
      signIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          issuer: string;
          onSignInHandle?: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        },
        Name
      >;
      signOut: FunctionReference<
        "mutation",
        "internal",
        { refreshToken: string },
        null,
        Name
      >;
      signUp: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds?: number;
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          createUserHandle?: string;
          issuer: string;
          onSignInHandle?: string;
          refreshTokenTtlSeconds?: number;
        },
        {
          accessToken: string;
          accessTokenExpiresAt: number;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        },
        Name
      >;
      signUpWithoutSession: FunctionReference<
        "mutation",
        "internal",
        {
          claims: {
            profile: any;
            providerAccountId: string;
            providerName: string;
          };
          createUserHandle?: string;
        },
        { userId: string },
        Name
      >;
    };
  };
