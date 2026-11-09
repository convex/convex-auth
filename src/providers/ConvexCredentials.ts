/**
 * Configure {@link ConvexCredentials} provider given a {@link ConvexCredentialsUserConfig}.
 *
 * This is for a very custom authentication implementation, often you can
 * use the [`Password`](https://labs.convex.dev/auth/api_reference/providers/Password) provider instead.
 *
 * ```ts
 * import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
 * import { convexAuth } from "@convex-dev/auth/server";
 *
 * export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
 *   providers: [
 *     ConvexCredentials({
 *       authorize: async (credentials, ctx) => {
 *         // Your custom logic here...
 *       },
 *     }),
 *   ],
 * });
 * ```
 *
 * @module
 */

import {
  AuthProviderConfig,
  ConvexCredentialsConfig,
  GenericActionCtxWithAuthConfig,
} from "@convex-dev/auth/server";
import { GenericDataModel } from "convex/server";
import { GenericId, Value } from "convex/values";

/**
 * The available options to a {@link ConvexCredentials} provider for Convex Auth.
 */
export interface ConvexCredentialsUserConfig<
  DataModel extends GenericDataModel = GenericDataModel,
> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link ConvexCredentials} providers.
   */
  id?: string;
  /**
   * Gives full control over how you handle the credentials received from the user
   * via the client-side `signIn` function.
   *
   * @returns This method expects a user ID to be returned for a successful login.
   * A session ID can be also returned and that session will be used.
   * If an error is thrown or `null` is returned, the sign-in will fail.
   */
  authorize: (
    /**
     * The available keys are determined by your call to `signIn()` on the client.
     *
     * You can add basic validation depending on your use case,
     * or you can use a popular library like [Zod](https://zod.dev) for validating
     * the input.
     */
    credentials: Partial<Record<string, Value | undefined>>,
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => Promise<{
    userId: string;
    sessionId?: GenericId<"authSessions">;
  } | null>;
  /**
   * Provide hashing and verification functions if you're
   * storing account secrets and want to control
   * how they're hashed.
   *
   * These functions will be called during
   * the `createAccount` and `retrieveAccount` execution when the
   * `secret` option is used.
   */
  crypto?: {
    /**
     * Function used to hash the secret.
     */
    hashSecret: (secret: string) => Promise<string>;
    /**
     * Function used to verify that the secret
     * matches the stored hash.
     */
    verifySecret: (secret: string, hash: string) => Promise<boolean>;
  };
  /**
   * Register extra providers used in the implementation of the credentials
   * provider. They will only be available to the `signInViaProvider`
   * function, and not to the `signIn` function exposed to clients.
   */
  extraProviders?: (AuthProviderConfig | undefined)[];
}

/**
 * The Credentials provider allows you to handle signing in with arbitrary credentials,
 * such as a username and password, domain, or two factor authentication or hardware device (e.g. YubiKey U2F / FIDO).
 */
export function ConvexCredentials<DataModel extends GenericDataModel>(
  config: ConvexCredentialsUserConfig<DataModel>,
): ConvexCredentialsConfig<DataModel> {
  return {
    id: "credentials",
    type: "credentials",
    authorize: async () => null,
    // @ts-expect-error Internal
    options: config,
  };
}
