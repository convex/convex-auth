import {
  actionGeneric,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  mutationGeneric,
  queryGeneric,
  RegisteredAction,
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
} from "../lib/types.ts";

/**
 * A type for a factory that returns a `RegisteredMutation` with a handler that
 * has access to provider-bound auth helpers on `ctx.convexAuth`.
 *
 * The signature mirrors convex's own `MutationBuilder` inference, simplified
 * where providers never need the generality: `args` is required (dropping the
 * zero-arg/function shorthand machinery) and there is no app data model
 * (providers are app-agnostic; their storage lives behind their own
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
 * The action flavor of {@link AuthMutationBuilder}.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export type AuthActionBuilder<Profile> = <
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends
    PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> =
    ReturnValueForOptionalValidator<ReturnsValidator>,
>(fn: {
  args: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericActionCtx<GenericDataModel> & ConvexAuthCtx<Profile>,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValue;
}) => RegisteredAction<"public", ObjectType<ArgsValidator>, ReturnValue>;

/**
 * The function builders a provider gets from {@link AuthCore.bindProvider}.
 *
 * Each builds a public Convex function whose handler receives the
 * provider-bound helpers on `ctx.convexAuth` alongside the standard ctx.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export type ProviderBuilders<Profile> = {
  authMutation: AuthMutationBuilder<Profile>;
  authAction: AuthActionBuilder<Profile>;
};

/**
 * The core auth API returned by {@link setupConvexAuth}: the session handlers the
 * app re-exports. The sign-in methods also use it to bind to the core.
 */
export type AuthCore = {
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
   * Reports whether the caller's access token identifies a signed-in user.
   *
   * Convex verifies the token's signature (against the deployment's JWKS)
   * before this query runs, so the result is a trustworthy authentication
   * verdict. SSR hosts call it with the token from the auth cookie to decide
   * authentication state, rather than trusting the (client-controlled) cookie
   * by merely decoding it.
   */
  isAuthenticated: RegisteredQuery<
    "public",
    Record<string, never>,
    Promise<boolean>
  >;
  /**
   * Register a provider with the core and get the function builders its
   * implementation uses.
   *
   * `name` identifies the provider in the core's `accounts` table: accounts
   * are keyed by `(name, providerAccountId)`, so it must be unique among the
   * providers bound to this core — a duplicate throws immediately (two
   * providers sharing a name would silently share accounts).
   *
   * Callbacks are registered once in `convex.config.ts` with
   * `defineAuthProvider`. Provider setup functions bind only their stable name.
   *
   * @internal Not public until the API for custom methods is stable.
   */
  bindProvider<Provider extends string, Profile>(options: {
    name: Provider;
  }): ProviderBuilders<Profile>;
};

/**
 * Build the app-facing auth-core handlers from the mounted `core` component
 * reference. Returns ready-to-export `signOut`/`refreshSession`/
 * `isAuthenticated` handlers. Give the result to the setup function of each
 * provider:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
 *   setupUsernamePassword(auth, {
 *     component: components.authPassword,
 *     usernameComponent: components.authUsername,
 *   });
 * ```
 *
 * The core never triggers a sign-in itself: it has no idea how any given
 * provider authenticates a user. *Triggering sign-in is each provider's
 * responsibility.* A provider verifies the user its own way (checking a
 * password, say) and then calls one of the helpers the core injects on
 * `ctx.convexAuth` to exchange the verified identity for a session:
 * `completeSignUp` when it has just established the account, `completeSignIn`
 * when the account already exists.
 *
 * Callbacks and token lifetimes are configured in `app.use(auth, { args })`.
 * The issuer stays app-side so it remains the bare deployment site URL.
 */
export function setupConvexAuth(options: {
  component: ComponentApi;
}): AuthCore {
  const { component } = options;

  const issuer = (): string => {
    const url = process.env.CONVEX_SITE_URL;
    if (!url) throw new Error("CONVEX_SITE_URL is not available");
    return url;
  };

  const refreshSession = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: vRefreshResult,
    handler: async (ctx, args): Promise<RefreshResult> => {
      return await ctx.runMutation(component.public.refresh, {
        refreshToken: args.refreshToken,
        issuer: issuer(),
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
      return (await ctx.auth.getUserIdentity()) !== null;
    },
  });

  // Names of providers bound to this core, for duplicate detection. Scoped to
  // this `setupConvexAuth` call (not module-global): the collision that matters is
  // two providers on the same core, whose accounts would silently share rows.
  const boundProviderNames = new Set<string>();

  const bindProvider = <Provider extends string, Profile>({
    name,
  }: {
    name: Provider;
  }): ProviderBuilders<Profile> => {
    if (boundProviderNames.has(name)) {
      throw new Error(
        `A provider named "${name}" is already bound to this auth core. ` +
          `Provider names key the accounts table, so each provider must ` +
          `have a unique name.`,
      );
    }
    boundProviderNames.add(name);

    // The helpers close over the live ctx; both mutation and action ctxs
    // expose the compatible `runMutation`/`runQuery` these need.
    const makeHelpers = (
      ctx:
        | GenericActionCtx<GenericDataModel>
        | GenericMutationCtx<GenericDataModel>,
    ) => ({
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
          issuer: issuer(),
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
          issuer: issuer(),
        });
      },
      // Creates the app user + account without a session, for providers where
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

    const authAction: AuthActionBuilder<Profile> = (fn) =>
      actionGeneric({
        args: fn.args as PropertyValidators,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler(
            { ...ctx, convexAuth: makeHelpers(ctx) },
            args as Parameters<typeof fn.handler>[1],
          ),
      });

    return { authMutation, authAction };
  };

  return { signOut, refreshSession, isAuthenticated, bindProvider };
}
