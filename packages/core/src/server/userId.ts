import {
  componentsGeneric,
  type Auth,
  type GenericDataModel,
  type GenericQueryCtx,
} from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { Impersonation } from "../lib/types.ts";

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
  ctx: AuthSessionCtx,
  component: ComponentApi = defaultComponent,
): Promise<GenericId<UsersTable> | null> {
  const session = await authSession(ctx, component);
  return session === null ? null : (session.userId as GenericId<UsersTable>);
}

/**
 * Who is impersonating the user the caller is signed in as, or `null` when
 * the caller's session is not an impersonation (or the caller is not signed
 * in).
 *
 * During an impersonation, {@link getAuthUserId} returns the impersonated
 * user, so that the app behaves as it does for that user. Call this function
 * where the app must know that somebody else is acting: to refuse a sensitive
 * action, or to record the real actor.
 *
 * ```ts
 * import { getAuthUserId, getImpersonation } from "@convex-dev/auth/server";
 *
 * export const deleteAccount = mutation({
 *   args: {},
 *   handler: async (ctx) => {
 *     const userId = await getAuthUserId(ctx);
 *     if (userId === null) {
 *       throw new Error("Not signed in");
 *     }
 *     if ((await getImpersonation(ctx)) !== null) {
 *       throw new Error("Not available while impersonating");
 *     }
 *     await ctx.db.delete("users", userId);
 *   },
 * });
 * ```
 *
 * It costs one component call, like `getAuthUserId`. It takes the same
 * optional type argument and `component` argument.
 */
export async function getImpersonation<UsersTable extends string = "users">(
  ctx: AuthSessionCtx,
  component: ComponentApi = defaultComponent,
): Promise<Impersonation<UsersTable> | null> {
  const session = await authSession(ctx, component);
  if (session === null || session.impersonation === undefined) {
    return null;
  }
  return {
    impersonatorUserId: session.impersonation
      .impersonatorUserId as GenericId<UsersTable>,
    expiresAt: session.impersonation.expiresAt,
  };
}

/**
 * The ID of the user the caller is signed in as, for a function that changes
 * how that user signs in (a password, a passkey, an email address). `null`
 * when the caller is not signed in.
 *
 * Throws `ConvexError({ code: "IMPERSONATING" })` when the caller's session is
 * an impersonation: an impersonator must never manage the credentials of the
 * user they act as, or they could keep the account after the impersonation
 * ends. Every function of a sign-in method that changes credentials calls
 * this function in place of {@link getAuthUserId}.
 *
 * @internal
 */
export async function getOwnAuthUserId<UsersTable extends string = "users">(
  ctx: AuthSessionCtx,
  component: ComponentApi = defaultComponent,
): Promise<GenericId<UsersTable> | null> {
  const session = await authSession(ctx, component);
  if (session === null) {
    return null;
  }
  if (session.impersonation !== undefined) {
    throw new ConvexError({
      code: "IMPERSONATING" as const,
      message:
        "This action is not available during an impersonation. Stop " +
        "impersonating and sign in as the user to change their credentials.",
    });
  }
  return session.userId as GenericId<UsersTable>;
}

/** What the helpers of this module need from the `ctx` of a function. */
type AuthSessionCtx = {
  auth: Auth;
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};

/**
 * The live session that the caller's access token identifies, or `null`. The
 * access token's subject is the session id, so the user is whoever the session
 * belongs to, for as long as the session exists.
 */
async function authSession(ctx: AuthSessionCtx, component: ComponentApi) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  return await ctx.runQuery(component.public.getSession, {
    sessionId: identity.subject,
  });
}
