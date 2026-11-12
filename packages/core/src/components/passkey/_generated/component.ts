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
    authentication: {
      finishAuthentication: FunctionReference<
        "mutation",
        "internal",
        {
          expectedOrigin: string | Array<string>;
          expectedRpId: string;
          purpose: string;
          response: {
            clientExtensionResults: {};
            id: string;
            rawId: string;
            response: {
              authenticatorData: string;
              clientDataJSON: string;
              signature: string;
              userHandle?: string;
            };
            type: "public-key";
          };
        },
        | { passkeyId: string; success: true; userId: string }
        | {
            success: false;
            userError:
              | { error: "UNKNOWN_CREDENTIAL" }
              | { error: "CHALLENGE_EXPIRED" }
              | { error: "PROTOCOL_ERROR" };
          },
        Name
      >;
      startAuthentication: FunctionReference<
        "mutation",
        "internal",
        { purpose: string; userId?: string },
        {
          allowCredentials: Array<{
            id: ArrayBuffer;
            transports?: Array<string>;
          }>;
          challenge: ArrayBuffer;
        },
        Name
      >;
    };
    registration: {
      _internal_dangerous_finishRegistrationForExistingUser: FunctionReference<
        "mutation",
        "internal",
        {
          expectedOrigin: string | Array<string>;
          expectedRpId: string;
          name?: string;
          response: {
            clientExtensionResults: {};
            id: string;
            rawId: string;
            response: {
              attestationObject: string;
              clientDataJSON: string;
              transports?: Array<string>;
            };
            type: "public-key";
          };
          verifiedUserId: string;
        },
        | { passkeyId: string; success: true }
        | {
            success: false;
            userError:
              | { error: "CHALLENGE_EXPIRED" }
              | { error: "PROTOCOL_ERROR" }
              | { error: "INVALID_NAME" };
          },
        Name
      >;
      _internal_dangerous_finishRegistrationForNewUser: FunctionReference<
        "mutation",
        "internal",
        {
          expectedOrigin: string | Array<string>;
          expectedRpId: string;
          name?: string;
          newUserId: string;
          response: {
            clientExtensionResults: {};
            id: string;
            rawId: string;
            response: {
              attestationObject: string;
              clientDataJSON: string;
              transports?: Array<string>;
            };
            type: "public-key";
          };
        },
        | { passkeyId: string; success: true }
        | {
            success: false;
            userError:
              | { error: "CHALLENGE_EXPIRED" }
              | { error: "PROTOCOL_ERROR" }
              | { error: "INVALID_NAME" };
          },
        Name
      >;
      checkRegistrationForNewUser: FunctionReference<
        "query",
        "internal",
        {
          expectedOrigin: string | Array<string>;
          expectedRpId: string;
          name?: string;
          response: {
            clientExtensionResults: {};
            id: string;
            rawId: string;
            response: {
              attestationObject: string;
              clientDataJSON: string;
              transports?: Array<string>;
            };
            type: "public-key";
          };
        },
        | { success: true }
        | {
            success: false;
            userError:
              | { error: "CHALLENGE_EXPIRED" }
              | { error: "PROTOCOL_ERROR" }
              | { error: "INVALID_NAME" };
          },
        Name
      >;
      deletePasskey: FunctionReference<
        "mutation",
        "internal",
        { passkeyId: string; userId: string },
        | { success: true }
        | { success: false; userError: { error: "PASSKEY_NOT_FOUND" } },
        Name
      >;
      deleteUser: FunctionReference<
        "mutation",
        "internal",
        { userId: string },
        null,
        Name
      >;
      listPasskeys: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          createdAt: number;
          credentialId: string;
          name?: string;
          passkeyId: string;
        }>,
        Name
      >;
      renamePasskey: FunctionReference<
        "mutation",
        "internal",
        { name: string; passkeyId: string; userId: string },
        | { success: true }
        | {
            success: false;
            userError:
              { error: "PASSKEY_NOT_FOUND" } | { error: "INVALID_NAME" };
          },
        Name
      >;
      startRegistrationForExistingUser: FunctionReference<
        "mutation",
        "internal",
        { verifiedUserId: string },
        {
          challenge: ArrayBuffer;
          excludeCredentials: Array<{
            id: ArrayBuffer;
            transports?: Array<string>;
          }>;
          userHandle: ArrayBuffer;
        },
        Name
      >;
      startRegistrationForNewUser: FunctionReference<
        "mutation",
        "internal",
        {},
        { challenge: ArrayBuffer; userHandle: ArrayBuffer },
        Name
      >;
    };
  };
