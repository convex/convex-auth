/**
 * Configure {@link Anonymous} provider given an {@link AnonymousConfig}.
 *
 * ```ts
 * import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
 * import { convexAuth } from "@convex-dev/auth/server";
 *
 * export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
 *   providers: [Anonymous],
 * });
 * ```
 *
 * @module
 */

import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import {
  GenericActionCtxWithAuthConfig,
  createAccount,
} from "@convex-dev/auth/server";
import {
  DocumentByName,
  GenericDataModel,
  WithoutSystemFields,
} from "convex/server";
import { Value } from "convex/values";

/**
 * The available options to an {@link Anonymous} provider for Convex Auth.
 */
export interface AnonymousConfig<
  DataModel extends GenericDataModel,
  UserDocument extends Record<string, Value> = DocumentByName<
    DataModel,
    "users"
  >,
> {
  /**
   * Uniquely identifies the provider, allowing to use
   * multiple different {@link Anonymous} providers.
   */
  id?: string;
  /**
   * Perform checks on provided params and customize the user
   * information stored after sign in.
   */
  profile?: (
    /**
     * The values passed to the `signIn` function.
     */
    params: Record<string, Value | undefined>,
    /**
     * Convex ActionCtx in case you want to read from or write to
     * the database.
     */
    ctx: GenericActionCtxWithAuthConfig<DataModel>,
  ) => WithoutSystemFields<UserDocument> & {
    isAnonymous: true;
  };
}

/**
 * An anonymous authentication provider.
 *
 * This provider doesn't require any user-provided information.
 */
export function Anonymous<DataModel extends GenericDataModel>(
  config: AnonymousConfig<DataModel> = {},
) {
  const provider = config.id ?? "anonymous";
  return ConvexCredentials<DataModel>({
    id: "anonymous",
    authorize: async (params, ctx) => {
      const profile = config.profile?.(params, ctx) ?? { isAnonymous: true };
      const { account } = await createAccount(ctx, {
        provider,
        account: { id: crypto.randomUUID() },
        profile: profile as any,
      });
      // END
      return { userId: account.userId as string };
    },
    ...config,
  });
}
