import {
  createFunctionHandle,
  GenericDataModel,
  GenericMutationCtx,
  mutationGeneric,
  queryGeneric,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
} from "convex/server";
import { ObjectType, PropertyValidators, v, Validator } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import {
  type TokenBundle,
  vRefreshResult,
  type RefreshResult,
  type ConvexAuthCtx,
  type UserCallbacks,
} from "../lib/types.ts";
import { getAuthUserId } from "./userId.ts";

/**
 * A type for a factory that returns a `RegisteredMutation` with a handler that
 * has access to method-bound auth helpers on `ctx.convexAuth`.
 *
 * The signature mirrors convex's own `MutationBuilder` inference, simplified
 * where methods never need the generality: `args` is required (dropping the
 * zero-arg/function shorthand machinery) and there is no app data model
 * (methods are app-agnostic; their storage lives behind their own
 * component's functions). `returns` keeps convex's exact optional-validator
 * scheme: with a validator, the handler's return is constrained to (a promise
 * of) its type; without one, it falls back to whatever the handler declares.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export type AuthMutationBuilder<Profile> = <
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends
    PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> =
    ReturnValueForOptionalValidator<ReturnsValidator>,
>(fn: {
  args: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericMutationCtx<GenericDataModel> & ConvexAuthCtx<Profile>,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValue;
}) => RegisteredMutation<"public", ObjectType<ArgsValidator>, ReturnValue>;

/**
 * The function builders a method gets from {@link AuthCore.bindProvider}.
 *
 * Each builds a public Convex function whose handler receives the
 * method-bound helpers on `ctx.convexAuth` alongside the standard ctx.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export type MethodBuilders<Profile> = {
  authMutation: AuthMutationBuilder<Profile>;
};

/**
 * The core auth API returned by {@link setupConvexAuth}: the session handlers the
 * app re-exports. The sign-in methods also use it to bind to the core.
 */
export type AuthCore<UsersTable extends string = string> = {
  /**
   * The name of the app's users table, as configured on {@link setupConvexAuth}.
   *
   * Carried on the value (not just in the type) so method setup functions
   * can infer `UsersTable` from the `core` they are handed, and so the name is
   * available for error messages.
   */
  usersTable: UsersTable;
  /**
   * The core component, as passed to {@link setupConvexAuth}.
   *
   * The sign-in methods pass it to `getAuthUserId`, so they work when the app
   * mounts the core under a name other than `auth`.
   *
   * @internal
   */
  component: ComponentApi;
  /**
   * Signs out of the current session.
   *
   * After this the refresh token is no longer valid.
   */
  signOut: RegisteredMutation<
    "public",
    { refreshToken: string },
    Promise<null>
  >;
  /**
   * Refreshes a session using the given token, rotating the refresh token.
   *
   * Resolves to one of the {@link RefreshResult} outcomes. `rotated` carries a
   * new token bundle to persist; the presented token keeps working until the
   * new refresh token is first used, so a lost response can be retried. A
   * `noSession` result should be treated as signed-out.
   */
  refreshSession: RegisteredMutation<
    "public",
    { refreshToken: string },
    Promise<RefreshResult>
  >;
  /**
   * Reports whether the caller's access token identifies a live session.
   *
   * Convex verifies the token's signature (against the deployment's JWKS)
   * before this query runs, so the result is a trustworthy authentication
   * verdict. SSR hosts call it with the token from the auth cookie to decide
   * authentication state, rather than trusting the (client-controlled) cookie
   * by merely decoding it.
   *
   * The query reads the session, so it returns `false` once the session is
   * gone (signed out elsewhere, revoked, or expired) even while the token
   * itself is still valid, and a subscription re-runs when that happens.
   */
  isAuthenticated: RegisteredQuery<
    "public",
    Record<string, never>,
    Promise<boolean>
  >;
  /**
   * Register a sign-in method with the core and get the function builders its
   * implementation uses.
   *
   * `name` identifies the method in the core's `accounts` table: accounts
   * are keyed by `(name, providerAccountId)`, so it must be unique among the
   * methods bound to this core — a duplicate throws immediately (two
   * methods sharing a name would silently share accounts).
   *
   * `createUser` is the app's user-creating callback for this method and
   * `onSignIn` is its optional per-sign-in hook (see {@link UserCallbacks}).
   *
   * Method setup functions call this from inside their `attachUserCallbacks`,
   * once the app has supplied the callbacks, so the builders can close over
   * them and a method with no way to create users cannot exist. It is not
   * meant to be called by application code directly.
   *
   * @internal Not public until the API for custom methods is stable.
   */
  bindProvider<Provider extends string, Profile>(
    options: {
      name: Provider;
    } & UserCallbacks<Provider, Profile, UsersTable>,
  ): MethodBuilders<Profile>;
};

/**
 * Build the app-facing auth-core handlers from the mounted `core` component
 * reference. Returns ready-to-export `signOut`/`refreshSession`/
 * `isAuthenticated` handlers. Give the result to the setup function of each
 * method:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
 *   setupUsernamePassword(auth, {
 *     component: components.authPassword,
 *     usernameComponent: components.authUsername,
 *   }).attachUserCallbacks({ createUser: internal.users.createUserPassword });
 * ```
 *
 * The core never triggers a sign-in itself: it has no idea how any given
 * method authenticates a user. *Triggering sign-in is the responsibility of
 * each method.* A method verifies the user its own way (checking a
 * password, say) and then calls one of the helpers the core injects on
 * `ctx.convexAuth` to exchange the verified identity for a session:
 * `completeSignUp` when it has just established the account, `completeSignIn`
 * when the account already exists.
 *
 * Token lifetimes are configurable here and default to 1m (access) and 30d
 * (refresh). The access-token TTL must be shorter than the refresh-token TTL,
 * and (since the client refreshes shortly before expiry) comfortably longer
 * than a few seconds.
 *
 * Changes to token TTLs impact newly minted tokens, not ones that have
 * already been issued.
 */
export function setupConvexAuth<UsersTable extends string = "users">(options: {
  component: ComponentApi;
  /**
   * The name of the app's users table. Defaults to `"users"`.
   *
   * The core never reads or writes the table — it only stores the id the app's
   * `createUser` callback returns. The name is a *type-level* contract: it makes
   * the `attachUserCallbacks` of every method demand a `createUser` returning
   * `Id<usersTable>` and an `onSignIn` taking one, so an app cannot accidentally
   * hand back an id from some other table (and, because the app then declares
   * `v.id(usersTable)`, Convex enforces the same thing at runtime).
   *
   * Set this if the app's users live in a table with a different name:
   *
   * ```ts
   * const auth = setupConvexAuth({ component: components.auth, usersTable: "members" });
   * ```
   */
  usersTable?: UsersTable;
  /**
   * Access-token lifetime in seconds. Defaults to 60 (1 minute).
   *
   * Changes to this value impact newly minted tokens, not ones that have
   * already been issued.
   */
  accessTokenTtlSeconds?: number;
  /**
   * Refresh-token lifetime in seconds. Defaults to 30 days.
   *
   * Changes to this value impact newly minted tokens, not ones that have
   * already been issued.
   */
  refreshTokenTtlSeconds?: number;
}): AuthCore<UsersTable> {
  const { component, accessTokenTtlSeconds, refreshTokenTtlSeconds } = options;
  // The default only matters to the type system (the core never touches the
  // table), but keep the value in sync with the `= "users"` default above.
  const usersTable = options.usersTable ?? ("users" as UsersTable);

  const refreshSession = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: vRefreshResult,
    handler: async (ctx, args): Promise<RefreshResult> => {
      return await ctx.runMutation(component.public.refresh, {
        refreshToken: args.refreshToken,
        accessTokenTtlSeconds,
        refreshTokenTtlSeconds,
      });
    },
  });

  const signOut = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
      await ctx.runMutation(component.public.signOut, {
        refreshToken: args.refreshToken,
      });
      return null;
    },
  });

  // Runs at the app deployment level (not inside the component) because only
  // there does `ctx.auth` reflect the caller's verified identity: Convex
  // checks the access token's signature against the deployment JWKS before
  // the handler runs, so a forged/unsigned token yields no identity here.
  const isAuthenticated = queryGeneric({
    args: {},
    returns: v.boolean(),
    handler: async (ctx): Promise<boolean> => {
      return (await getAuthUserId(ctx, component)) !== null;
    },
  });

  // Names of methods bound to this core, for duplicate detection. Scoped to
  // this `setupConvexAuth` call (not module-global): the collision that matters is
  // two methods on the same core, whose accounts would silently share rows.
  const boundMethodNames = new Set<string>();

  const bindProvider = <Provider extends string, Profile>({
    name,
    createUser,
    onSignIn,
  }: {
    name: Provider;
  } & UserCallbacks<
    Provider,
    Profile,
    UsersTable
  >): MethodBuilders<Profile> => {
    if (boundMethodNames.has(name)) {
      throw new Error(
        `A sign-in method named "${name}" is already bound to this auth core. ` +
          `Method names key the accounts table, so each method must ` +
          `have a unique name.`,
      );
    }
    boundMethodNames.add(name);

    // Undefined when the app attached no `onSignIn`, which tells the core to
    // mint the session without notifying the app.
    const onSignInHandle = async (): Promise<string | undefined> =>
      onSignIn === undefined ? undefined : await createFunctionHandle(onSignIn);

    /**
     * Revoke the given sessions (as `listSessions` lists them) and count the
     * active ones revoked. Expired sessions are deleted too, but not counted.
     */
    const revokeListedSessions = async (
      ctx: GenericMutationCtx<GenericDataModel>,
      sessions: { sessionId: string; expiresAt: number }[],
    ): Promise<number> => {
      if (sessions.length === 0) {
        return 0;
      }
      const revoked = new Set(
        await ctx.runMutation(component.public.revokeSessions, {
          sessionIds: sessions.map(({ sessionId }) => sessionId),
        }),
      );
      const now = Date.now();
      return sessions.filter(
        ({ sessionId, expiresAt }) => revoked.has(sessionId) && expiresAt > now,
      ).length;
    };

    // The helpers close over the live ctx.
    const makeHelpers = (ctx: GenericMutationCtx<GenericDataModel>) => ({
      completeSignUp: async (args: {
        providerAccountId: string;
        profile: Profile;
      }): Promise<TokenBundle> => {
        return await ctx.runMutation(component.public.signUp, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          createUserHandle: await createFunctionHandle(createUser),
          onSignInHandle: await onSignInHandle(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      completeSignIn: async (args: {
        providerAccountId: string;
        profile: Profile;
      }): Promise<TokenBundle> => {
        return await ctx.runMutation(component.public.signIn, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          onSignInHandle: await onSignInHandle(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      // Creates the app user + account without a session, for methods where
      // the user must complete a step (e.g. an email validation) before the
      // first sign-in.
      signUpWithoutSession: async (args: {
        providerAccountId: string;
        profile: Profile;
      }): Promise<{ userId: string }> => {
        return await ctx.runMutation(component.public.signUpWithoutSession, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          createUserHandle: await createFunctionHandle(createUser),
        });
      },
      resolveUserId: async (
        providerAccountId: string,
      ): Promise<string | null> => {
        return await ctx.runQuery(component.public.getUserIdByAccount, {
          provider: name,
          providerAccountId,
        });
      },
      revokeOtherSessions: async (): Promise<number> => {
        const identity = await ctx.auth.getUserIdentity();
        if (identity === null) {
          return 0;
        }
        const currentSessionId = identity.subject;
        const session = await ctx.runQuery(component.public.getSession, {
          sessionId: currentSessionId,
        });
        // A revoked current session can't sign out other sessions.
        if (session === null) {
          return 0;
        }
        const sessions = await ctx.runQuery(component.public.listSessions, {
          userId: session.userId,
        });
        return await revokeListedSessions(
          ctx,
          sessions.filter(({ sessionId }) => sessionId !== currentSessionId),
        );
      },
      revokeAllSessions: async (userId: string): Promise<number> => {
        const sessions = await ctx.runQuery(component.public.listSessions, {
          userId,
        });
        return await revokeListedSessions(ctx, sessions);
      },
    });

    const authMutation: AuthMutationBuilder<Profile> = (fn) =>
      mutationGeneric({
        args: fn.args as PropertyValidators,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler(
            { ...ctx, convexAuth: makeHelpers(ctx) },
            args as Parameters<typeof fn.handler>[1],
          ),
      });

    return { authMutation };
  };

  return {
    usersTable,
    component,
    signOut,
    refreshSession,
    isAuthenticated,
    bindProvider,
  };
}
