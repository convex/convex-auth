/**
 * The Convex functions of the core, exported at `@convex-dev/auth/server`.
 *
 * {@link setupConvexAuth} builds the session functions that the app exports.
 * {@link convexAuthProvider} builds the provider that `convex/auth.config.ts`
 * lists.
 * {@link getAuthUserId} reads the user id of the caller in a query, a
 * mutation, or an action.
 *
 * @module
 */

export { convexAuthProvider } from "./authProvider.ts";
export { setupConvexAuth, type AuthCore } from "./setup.ts";
export { getAuthUserId } from "./userId.ts";
