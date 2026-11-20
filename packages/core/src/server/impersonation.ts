import {
  type GenericDataModel,
  type GenericMutationCtx,
  mutationGeneric,
  queryGeneric,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { type GenericId, v } from "convex/values";
import {
  type AuthorizeImpersonationFn,
  type Impersonation,
  type ImpersonateUserResult,
  type StopImpersonatingResult,
  vImpersonateUserResult,
  vStopImpersonatingResult,
} from "../lib/types.ts";
import type { AuthCore } from "./setup.ts";
import { getImpersonation } from "./userId.ts";

/** How long an impersonation lasts unless the app says otherwise. */
const DEFAULT_IMPERSONATION_MAX_DURATION_SECONDS = 60 * 60; // 1 hour

/**
 * How much longer than an access token an impersonation must last at least.
 * The client refreshes shortly before its access token expires, and an
 * impersonation that ends before the first refresh would end without one.
 */
const MIN_DURATION_PAST_ACCESS_TOKEN_TTL_SECONDS = 60;

/**
 * Let authorized users of the app act as another user for a limited time, for
 * example support staff who look at what a user sees.
 *
 * Returns the functions to export from `convex/auth.ts`:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { impersonateUser, stopImpersonating, impersonation } =
 *   setupImpersonation(auth).attachAuthorization({
 *     authorize: internal.users.authorizeImpersonation,
 *   });
 * ```
 *
 * `impersonateUser` gives the caller a session of the user they name. During
 * it, {@link getAuthUserId} returns that user, and {@link getImpersonation}
 * returns who is really acting. `stopImpersonating` ends it and gives the
 * caller a session of their own again. `impersonation` is a query that
 * reports the same as `getImpersonation`, for the UI.
 *
 * The app decides who may impersonate whom. The core has no notion of roles,
 * thus `authorize` is required:
 *
 * ```ts
 * export const authorizeImpersonation = internalMutation({
 *   args: { impersonatorUserId: v.id("users"), targetUserId: v.id("users") },
 *   returns: v.boolean(),
 *   handler: async (ctx, { impersonatorUserId, targetUserId }) => {
 *     const impersonator = await ctx.db.get("users", impersonatorUserId);
 *     const target = await ctx.db.get("users", targetUserId);
 *     if (impersonator === null || target === null) {
 *       return false;
 *     }
 *     // Admins only, and never another admin.
 *     return impersonator.role === "admin" && target.role !== "admin";
 *   },
 * });
 * ```
 *
 * The core does not check that the target user exists: `authorize` must.
 *
 * What the core guarantees:
 *
 * - An impersonation ends after `maxDurationSeconds`, and never outlives the
 *   impersonator's own session.
 * - The impersonator's session and the impersonation end together. Signing
 *   the impersonator out, or revoking their sessions, ends the impersonation.
 *   Only `stopImpersonating` ends the impersonation alone.
 * - An impersonation cannot start another one.
 * - The functions of the sign-in methods that change credentials (a
 *   password, a passkey, an email address) refuse an impersonation session.
 * - `onSignIn` does not run: the impersonated user did not sign in.
 *
 * Under SSR, list `impersonateUser` and `stopImpersonating` in `signIn` of
 * `setupConvexAuthServer`, like any function that returns a session.
 */
export function setupImpersonation<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: {
    /**
     * How long an impersonation may last, in seconds. Defaults to 3600 (1
     * hour).
     *
     * Must be at least 60 seconds longer than the access-token TTL, and at
     * most `sessionMaxLifetimeSeconds`. An impersonation also never outlives
     * the session of the impersonator who started it.
     *
     * Changes to this value apply to the impersonations that start after the
     * change.
     */
    maxDurationSeconds?: number;
  } = {},
) {
  const { component, ttl, usersTable } = core;
  const maxDurationSeconds =
    options.maxDurationSeconds ?? DEFAULT_IMPERSONATION_MAX_DURATION_SECONDS;
  // Checked once, when the app's modules load, so an invalid configuration
  // fails the deploy rather than the first impersonation.
  if (!Number.isFinite(maxDurationSeconds)) {
    throw new Error("The impersonation max duration must be a finite number.");
  }
  if (
    maxDurationSeconds <
    ttl.accessTokenTtlSeconds + MIN_DURATION_PAST_ACCESS_TOKEN_TTL_SECONDS
  ) {
    throw new Error(
      `The impersonation max duration must be at least ` +
        `${MIN_DURATION_PAST_ACCESS_TOKEN_TTL_SECONDS} seconds longer than ` +
        `the access-token TTL.`,
    );
  }
  if (maxDurationSeconds > ttl.sessionMaxLifetimeSeconds) {
    throw new Error(
      "The impersonation max duration must be at most the session max " +
        "lifetime.",
    );
  }

  return {
    /**
     * Supply the app's rule and get the impersonation functions to export.
     *
     * `authorize` is an internal mutation that returns whether
     * `impersonatorUserId` may act as `targetUserId`. See
     * {@link AuthorizeImpersonationFn}. It is required: the core has no
     * notion of roles, thus there is no default rule.
     *
     * This is a second call, like the `attachUserCallbacks` of the sign-in
     * methods, because `authorize` is a reference into the app's own `api`.
     * The exports of `convex/auth.ts` are part of that `api`, and TypeScript
     * cannot infer them from a generic call that takes such a reference.
     */
    attachAuthorization({
      authorize,
    }: {
      authorize: AuthorizeImpersonationFn<UsersTable>;
    }): ImpersonationFunctions<UsersTable> {
      return impersonationFunctions(authorize);
    },
  };

  function impersonationFunctions(
    authorize: AuthorizeImpersonationFn<UsersTable>,
  ): ImpersonationFunctions<UsersTable> {
    const impersonateUser = mutationGeneric({
      args: { userId: v.id(usersTable) },
      returns: vImpersonateUserResult,
      handler: async (
        ctx: GenericMutationCtx<GenericDataModel>,
        { userId: targetUserId },
      ): Promise<ImpersonateUserResult> => {
        const identity = await ctx.auth.getUserIdentity();
        const session =
          identity === null
            ? null
            : await ctx.runQuery(component.public.getSession, {
                sessionId: identity.subject,
              });
        if (identity === null || session === null) {
          return { status: "error", userError: { error: "NOT_LOGGED_IN" } };
        }
        if (session.impersonation !== undefined) {
          return {
            status: "error",
            userError: { error: "ALREADY_IMPERSONATING" },
          };
        }
        if (session.userId === targetUserId) {
          return {
            status: "error",
            userError: { error: "CANNOT_IMPERSONATE_SELF" },
          };
        }
        const authorized = await ctx.runMutation(authorize, {
          impersonatorUserId: session.userId as GenericId<UsersTable>,
          targetUserId: targetUserId as GenericId<UsersTable>,
        });
        // Anything but `true` refuses, so that an `authorize` with a wrong
        // return value cannot allow by accident.
        if (authorized !== true) {
          return { status: "error", userError: { error: "NOT_AUTHORIZED" } };
        }
        // Everything from here on succeeds or throws. A throw rolls back
        // whatever `authorize` wrote, thus an audit record never commits
        // without its impersonation.
        const tokens = await ctx.runMutation(
          component.public._internal_dangerous_impersonate,
          {
            impersonatorSessionId: identity.subject,
            targetUserId,
            maxDurationSeconds,
            ...ttl,
          },
        );
        return { status: "complete", tokens };
      },
    });

    const stopImpersonating = mutationGeneric({
      args: {},
      returns: vStopImpersonatingResult,
      handler: async (ctx): Promise<StopImpersonatingResult> => {
        const identity = await ctx.auth.getUserIdentity();
        if (identity === null) {
          return { status: "error", userError: { error: "NOT_IMPERSONATING" } };
        }
        const result = await ctx.runMutation(
          component.public._internal_dangerous_stopImpersonation,
          { sessionId: identity.subject, ...ttl },
        );
        switch (result.kind) {
          case "restored":
            return { status: "complete", tokens: result.tokens };
          case "notImpersonating":
            return {
              status: "error",
              userError: { error: "NOT_IMPERSONATING" },
            };
          case "impersonatorSessionEnded":
            return {
              status: "error",
              userError: { error: "IMPERSONATOR_SESSION_ENDED" },
            };
        }
      },
    });

    // Runs at the app deployment level, like `isAuthenticated`: only there does
    // `ctx.auth` reflect the caller's verified identity.
    const impersonation = queryGeneric({
      args: {},
      returns: v.union(
        v.object({
          impersonatorUserId: v.id(usersTable),
          expiresAt: v.number(),
        }),
        v.null(),
      ),
      handler: async (ctx): Promise<Impersonation<UsersTable> | null> =>
        await getImpersonation<UsersTable>(ctx, component),
    });

    return { impersonateUser, stopImpersonating, impersonation };
  }
}

/** The functions that `setupImpersonation` gives the app to export. */
type ImpersonationFunctions<UsersTable extends string> = {
  /**
   * Start acting as the user `userId`. Resolves to an
   * {@link ImpersonateUserResult}.
   */
  impersonateUser: RegisteredMutation<
    "public",
    { userId: GenericId<UsersTable> },
    Promise<ImpersonateUserResult>
  >;
  /**
   * Stop the impersonation of the caller's session, and go back to the
   * caller's own session. Resolves to a {@link StopImpersonatingResult}.
   */
  stopImpersonating: RegisteredMutation<
    "public",
    Record<string, never>,
    Promise<StopImpersonatingResult>
  >;
  /**
   * Who is impersonating the user the caller is signed in as, and until when,
   * or `null` when the caller's session is not an impersonation.
   */
  impersonation: RegisteredQuery<
    "public",
    Record<string, never>,
    Promise<Impersonation<UsersTable> | null>
  >;
};
