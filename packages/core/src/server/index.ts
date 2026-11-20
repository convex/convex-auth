/**
 * The Convex functions of the core, exported at `@convex-dev/auth/server`.
 *
 * {@link setupConvexAuth} builds the session functions that the app exports.
 * {@link convexAuthProvider} builds the provider that `convex/auth.config.ts`
 * lists.
 * {@link getAuthUserId} reads the user id of the caller in a query, a
 * mutation, or an action.
 * {@link setupImpersonation} builds the functions that let an authorized user
 * act as another user, and {@link getImpersonation} tells when that is the
 * case.
 *
 * @module
 */

export { convexAuthProvider } from "./authProvider.ts";
export { setupConvexAuth, type AuthCore } from "./setup.ts";
export { setupImpersonation } from "./impersonation.ts";
export { getAuthUserId, getImpersonation } from "./userId.ts";
