/**
 * When the user of the current session last proved who they are, for the
 * actions that need a recent proof (OIDC's `auth_time` and `max_age`).
 *
 * @module
 */
import {
  componentsGeneric,
  type Auth,
  type GenericDataModel,
  type GenericQueryCtx,
} from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import { componentPathOf } from "../lib/componentPath.ts";
import type {
  NotLoggedInErrorData,
  ReauthenticationRequiredErrorData,
} from "../lib/reauthentication.ts";

// The core component mounted under its default name, `auth`. See `userId.ts`.
const defaultComponent = (
  componentsGeneric() as unknown as { auth: ComponentApi }
).auth;

/** When and with which component the user last proved who they are. */
export type AuthenticationTime = {
  /** The time, in milliseconds since the epoch. */
  authenticatedAt: number;
  /**
   * The path of the component that verified the user, for example
   * `"authPassword"` or `"authPasskey"`.
   */
  component: string;
};

/** The options of {@link getAuthenticationTime}. */
export type GetAuthenticationTimeOptions = {
  /**
   * Count only the authentications made with these components, for example
   * `[components.authPasskey]`. By default every component counts.
   */
  authenticatedBy?: object[];
  /**
   * The core component, when the app mounts it under another name than
   * `auth`.
   */
  component?: ComponentApi;
};

type AuthCtx = {
  auth: Auth;
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};

async function readAuthenticationTime(
  ctx: AuthCtx,
  options: GetAuthenticationTimeOptions,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  const component = options.component ?? defaultComponent;
  // The access token's subject is the session id.
  return await ctx.runQuery(component.public.getAuthenticationTime, {
    sessionId: identity.subject,
    components: options.authenticatedBy?.map(componentPathOf),
  });
}

/**
 * When the user of the current session last proved who they are, and with
 * which component. Returns `null` when the caller is not signed in, or when
 * no authentication of the session matches `authenticatedBy`.
 *
 * The sign-in that created the session counts, and so does every later
 * re-authentication on this session, for example with
 * `useReauthenticateWithPasskey`. A re-authentication counts for its own
 * session only, not for the other sessions of the user.
 *
 * ```ts
 * import { getAuthenticationTime } from "@convex-dev/auth/server";
 *
 * export const lastAuthenticatedAt = query({
 *   args: {},
 *   handler: async (ctx) => {
 *     const time = await getAuthenticationTime(ctx);
 *     return time?.authenticatedAt ?? null;
 *   },
 * });
 * ```
 */
export async function getAuthenticationTime(
  ctx: AuthCtx,
  options: GetAuthenticationTimeOptions = {},
): Promise<AuthenticationTime | null> {
  const result = await readAuthenticationTime(ctx, options);
  return result?.authentication ?? null;
}

/** The options of {@link requireRecentAuthentication}. */
export type RequireRecentAuthenticationOptions =
  GetAuthenticationTimeOptions & {
    /**
     * How long ago, in seconds, the user may have last proved who they are.
     */
    maxAgeSeconds: number;
  };

/**
 * Check that the user of the current session proved who they are in the last
 * `maxAgeSeconds`, and return the user's id. Call it before a sensitive
 * action, such as changing an email address or deleting an account.
 *
 * Throws a `ConvexError` whose `data` is:
 *
 * - `{ error: "NOT_LOGGED_IN" }` when the caller is not signed in.
 * - `{ error: "REAUTHENTICATION_REQUIRED" }` when the latest authentication
 *   is older than `maxAgeSeconds`, or when there is none with the components
 *   of `authenticatedBy`. On the client, check for it with
 *   `isReauthenticationRequiredError`, ask the user to re-authenticate, and
 *   try again.
 *
 * ```ts
 * import { requireRecentAuthentication } from "@convex-dev/auth/server";
 *
 * export const deleteAccount = mutation({
 *   args: {},
 *   handler: async (ctx) => {
 *     const { userId } = await requireRecentAuthentication(ctx, {
 *       maxAgeSeconds: 5 * 60,
 *     });
 *     await ctx.db.delete("users", userId);
 *   },
 * });
 * ```
 *
 * Use it in mutations and actions. A query result stays cached while its
 * data does not change, thus a query would keep passing after the time is up.
 */
export async function requireRecentAuthentication<
  UsersTable extends string = "users",
>(
  ctx: AuthCtx,
  options: RequireRecentAuthenticationOptions,
): Promise<AuthenticationTime & { userId: GenericId<UsersTable> }> {
  const result = await checkRecentAuthentication(ctx, options);
  if (!result.success) {
    throw new ConvexError<
      NotLoggedInErrorData | ReauthenticationRequiredErrorData
    >({ error: result.error });
  }
  return {
    ...result.authentication,
    userId: result.userId as GenericId<UsersTable>,
  };
}

/**
 * The check of {@link requireRecentAuthentication}, as a result instead of an
 * error, for the methods whose functions return a `userError`.
 *
 * @internal
 */
export async function checkRecentAuthentication(
  ctx: AuthCtx,
  options: RequireRecentAuthenticationOptions,
): Promise<
  | { success: true; userId: string; authentication: AuthenticationTime }
  | {
      success: false;
      error:
        | NotLoggedInErrorData["error"]
        | ReauthenticationRequiredErrorData["error"];
    }
> {
  const { maxAgeSeconds } = options;
  validateMaxAgeSeconds(maxAgeSeconds, "maxAgeSeconds");
  const result = await readAuthenticationTime(ctx, options);
  if (result === null) {
    return { success: false, error: "NOT_LOGGED_IN" };
  }
  const { authentication } = result;
  if (
    authentication === null ||
    Date.now() - authentication.authenticatedAt > maxAgeSeconds * 1000
  ) {
    return { success: false, error: "REAUTHENTICATION_REQUIRED" };
  }
  return { success: true, userId: result.userId, authentication };
}

/**
 * Throw when `seconds` is not a finite number of seconds, 0 or more.
 *
 * @internal
 */
export function validateMaxAgeSeconds(seconds: number, name: string) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `\`${name}\` must be a finite number of seconds, 0 or more. ` +
        `Got ${seconds}.`,
    );
  }
}
