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
      _internal_dangerous_recordReauthentication: FunctionReference<
        "mutation",
        "internal",
        { componentPath: string; sessionId: string; userId: string },
        { authenticatedAt: number },
        Name
      >;
      _internal_dangerous_signIn: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds: number;
          claims: { method: string; profile: any };
          componentPath: string;
          onSignInHandle?: string;
          refreshInactivityTimeoutSeconds: number;
          sessionMaxLifetimeSeconds: number;
          userId: string;
        },
        {
          accessToken: string;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        },
        Name
      >;
      _internal_dangerous_signUp: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds: number;
          claims: { method: string; profile: any };
          componentPath: string;
          createUserHandle: string;
          onSignInHandle?: string;
          refreshInactivityTimeoutSeconds: number;
          sessionMaxLifetimeSeconds: number;
        },
        {
          accessToken: string;
          refreshToken: string;
          refreshTokenExpiresAt: number;
          userId: string;
        },
        Name
      >;
      _internal_dangerous_signUpWithoutSession: FunctionReference<
        "mutation",
        "internal",
        { claims: { method: string; profile: any }; createUserHandle: string },
        { userId: string },
        Name
      >;
      getAuthenticationTime: FunctionReference<
        "query",
        "internal",
        { components?: Array<string>; sessionId: string },
        {
          authentication: { authenticatedAt: number; component: string } | null;
          userId: string;
        } | null,
        Name
      >;
      getSession: FunctionReference<
        "query",
        "internal",
        { sessionId: string },
        { userId: string } | null,
        Name
      >;
      listSessions: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          creationTime: number;
          lastRefreshedAt: number;
          sessionId: string;
        }>,
        Name
      >;
      markUserIdCreated: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      refresh: FunctionReference<
        "mutation",
        "internal",
        {
          accessTokenTtlSeconds: number;
          refreshInactivityTimeoutSeconds: number;
          refreshToken: string;
          sessionMaxLifetimeSeconds: number;
        },
        | {
            kind: "rotated";
            tokens: {
              accessToken: string;
              refreshToken: string;
              refreshTokenExpiresAt: number;
              userId: string;
            };
          }
        | { kind: "noSession" },
        Name
      >;
      revokeSessions: FunctionReference<
        "mutation",
        "internal",
        { sessionIds: Array<string> },
        Array<string>,
        Name
      >;
      signOut: FunctionReference<
        "mutation",
        "internal",
        { refreshToken: string },
        null,
        Name
      >;
    };
  };
