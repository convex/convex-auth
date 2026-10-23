import {
  componentsGeneric,
  type Auth,
  type GenericDataModel,
  type GenericQueryCtx,
} from "convex/server";
import type { GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";

// The core component mounted under its default name, `auth` (`app.use(auth)`
// without a `name`). It is the same reference as the app's `components.auth`,
// so `getAuthUserId` needs only `ctx` in the common case.
const defaultComponent = (
  componentsGeneric() as unknown as { auth: ComponentApi }
).auth;

/**
 * The ID of the user the caller is signed in as, or `null` when the caller is
 * not signed in.
 *
 * Call it with the function's `ctx` (query, mutation, or action).
 *
 * ```ts
 * import { getAuthUserId } from "@convex-dev/auth/server";
 *
 * export const loggedInUser = query({
 *   args: {},
 *   handler: async (ctx) => {
 *     const userId = await getAuthUserId(ctx);
 *     if (userId === null) {
 *       return null;
 *     }
 *     return await ctx.db.get("users", userId);
 *   },
 * });
 * ```
 *
 * The JWT the client shares with the backend identifies a session, not a
 * user: this looks the session up, at the cost of one component call, and
 * returns `null` once it is gone (signed out, revoked, or expired) even while
 * the token itself is still valid. In a subscribed query, deleting the session
 * re-runs the query.
 *
 * The id is typed as one in the `"users"` table. If the app's users live in a
 * table with another name (see `setupConvexAuth`'s `usersTable` option), name it
 * here too:
 *
 * ```ts
 * const userId = await getAuthUserId<"members">(ctx);
 * ```
 *
 * By default this calls the core component mounted under its default name,
 * `auth`. If the app mounts it under another name, pass that component:
 *
 * ```ts
 * const userId = await getAuthUserId(ctx, components.myAuth);
 * ```
 */
export async function getAuthUserId<UsersTable extends string = "users">(
  ctx: {
    auth: Auth;
    runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
  },
  component: ComponentApi = defaultComponent,
): Promise<GenericId<UsersTable> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  // The access token's subject is the session id, so the user is whoever the
  // session belongs to, for as long as the session exists.
  const session = await ctx.runQuery(component.public.getSession, {
    sessionId: identity.subject,
  });
  return session === null ? null : (session.userId as GenericId<UsersTable>);
}
