import { FunctionReference, FunctionReference_future } from "convex/server";

import { GenericId, Infer, v, type Validator } from "convex/values";

/**
 * Shared contracts that cross a module boundary within Convex Auth. That includes
 * validators (and their inferred types) for what the core's session functions
 * accept and return, any function references, and the wire shapes an SSR host's
 * auth routes exchange with the browser. Each is declared once here and reused
 * wherever the core, the app, the server handlers or the client needs it, so the
 * shapes can never drift between declaration sites.
 *
 * This module deliberately depends on nothing else in the package, which is what
 * lets both the server and the browser halves import from it without either
 * reaching into the other's tree.
 */

/**
 * The session a successful sign-in (or refresh) mints: a short-lived access
 * token plus the rotating refresh token with its expiry, and the app user id
 * the access token is minted for. The access token's expiry is its JWT `exp`
 * claim.
 */
export const vTokenBundle = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  refreshTokenExpiresAt: v.number(),
  userId: v.string(),
});

export type TokenBundle = Infer<typeof vTokenBundle>;

/**
 * A complete sign-in result.
 *
 * Sign-in methods compose this into their result union rather than declaring the
 * complete arm themselves. Fixing where the minted bundle sits is what lets the
 * SSR auth proxy find the refresh token without knowing which method produced
 * the response, and lets it reject a shape it doesn't recognize instead of
 * forwarding tokens to the browser.
 */
export const vSignInComplete = v.object({
  status: v.literal("complete"),
  tokens: vTokenBundle,
});

export type SignInComplete = Infer<typeof vSignInComplete>;

/**
 * A sign-in that resulted in an error, carrying the method's own
 * `userError` codes.
 *
 * The `status` is shared so every arm of every method is discriminated the
 * same way; the payload is not, because what can go wrong is method-specific.
 *
 * ```ts
 * const signInResult = v.union(
 *   vSignInComplete,
 *   vSignInError(v.object({ error: v.literal("USER_NOT_FOUND") })),
 * );
 * ```
 */
export function vSignInError<
  UserError extends Validator<unknown, "required", string>,
>(userError: UserError) {
  return v.object({ status: v.literal("error"), userError });
}

/** The inferred shape of a {@link vSignInError} arm. */
export type SignInError<UserError> = {
  status: "error";
  userError: UserError;
};

/**
 * The full shared sign-in envelope.
 *
 * Represents sign-ins that ran to completion and those that hit an error.
 *
 * `userError` is `unknown` here because each method declares its own codes.
 */
export type SignInEnvelope = SignInComplete | SignInError<unknown>;

/** The `status` discriminant of every {@link SignInEnvelope}. */
export type SignInStatus = SignInEnvelope["status"];

/**
 * The token bundle that an SSR route hands back to the client. It is a slimmed
 * down version of a {@link TokenBundle} with the refresh token (and its
 * expiry) removed: under SSR the refresh token lives only in an httpOnly
 * cookie and never reaches client JS.
 */
export type SlimTokenBundle = {
  accessToken: string;
  userId: string;
};

/**
 * Strip down a {@link TokenBundle} down to a {@link SlimTokenBundle},
 * dropping the refresh token so it is never sent to the browser.
 */
export function makeSlimBundle(bundle: TokenBundle): SlimTokenBundle {
  return {
    accessToken: bundle.accessToken,
    userId: bundle.userId,
  };
}

/**
 * The JSON body of every SSR auth session response: the refresh handler, the
 * sign-out handler, and the cross-site refusal all reply with this shape, and
 * the client parses it without looking at the status. `tokens` is null whenever
 * there is no live session to report (a dead or missing refresh cookie, a
 * completed sign-out, a refused origin).
 */
export type AuthSessionResponse = {
  tokens: SlimTokenBundle | null;
};

/**
 * A sign-in result as clients see it, with the token bundle narrowed to what
 * every session model delivers.
 *
 * Under SSR the auth proxy strips the refresh token before the response reaches
 * the browser, so the slim bundle is all the two models have in common.
 * Declaring that here makes the stripping a widening of the value rather than a
 * broken contract: a {@link TokenBundle} is assignable to a
 * {@link SlimTokenBundle}, so one type stays true for both.
 *
 * It also stops callers depending on the refresh token. Handing the bundle to
 * `setSession` is the only supported use; an app that needs the raw token can
 * call its Convex function with the generated reference and get the full type.
 *
 * Distributes over a result union, leaving failure arms untouched.
 */
export type ClientView<T> = T extends { tokens: TokenBundle }
  ? Omit<T, "tokens"> & { tokens: SlimTokenBundle }
  : T;

/**
 * The result of refreshing a session. The `kind` will be one of:
 *
 *  * `rotated`: the presented token was valid and `tokens` carries a fresh
 *    access token and its successor refresh token. The client should persist both. The token
 *    presented stays valid until the successor is first used, so a client that
 *    never receives this result can retry with the token it already has.
 *  * `noSession`: the token is unknown, expired, or one that should be in
 *    nobody's hands any more (which also revokes its session). The client should clear any stored session, and treat the user as signed out.
 */
export const vRefreshResult = v.union(
  v.object({ kind: v.literal("rotated"), tokens: vTokenBundle }),
  v.object({ kind: v.literal("noSession") }),
);

export type RefreshResult = Infer<typeof vRefreshResult>;

/** The app's `refreshSession` mutation reference: exchange a refresh token for
 * a fresh session. See {@link vRefreshResult} for the outcomes. */
export type RefreshSessionFn = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  RefreshResult
>;

/** The app's `signOut` mutation reference: revoke the session for a refresh
 * token. */
export type SignOutFn = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  null
>;

/**
 * The app's `isAuthenticated` query reference: reports whether the access token
 * the query is called with identifies a signed-in user.
 */
export type IsAuthenticatedFn = FunctionReference<
  "query",
  "public",
  Record<string, never>,
  boolean
>;

/**
 * The auth functions the app exports from `setupConvexAuth`.
 * Passed as references (not names) because an app may re-export them under any
 * names. Consumed by both SPA and SSR implementations.
 */
export type ConvexAuthApi = {
  refreshSession: RefreshSessionFn;
  signOut: SignOutFn;
  isAuthenticated: IsAuthenticatedFn;
};

/**
 * Shared identity-claims contract between the *sign-in methods* that
 * authenticate users and the *core* component.
 *
 * After a sign-in method authenticates a user it produces this plain payload;
 * the app forwards it to the core's `signUp` or `signIn`, which hands it to
 * the app's user callbacks and records the sign-in method on the session. The
 * core stores no account for it: the sign-in method's own component keeps the
 * map from its identity to the app user id, and resolves it before calling
 * the core. Sign-in methods never call the core directly, they only know how
 * to produce these claims.
 */
export const vAuthClaims = v.object({
  /**
   * The name that the sign-in method registers with the core, e.g.
   * "password" for the `usernamePassword` method.
   */
  providerName: v.string(),
  /**
   * Stable, provider-scoped account identifier (e.g. the Google account ID).
   */
  providerAccountId: v.string(),
  /** Arbitrary profile data the method learned about the user. */
  profile: v.any(),
});

export type AuthClaims = Infer<typeof vAuthClaims>;

/**
 * The `providerAccountId` a sign-in method sends to `completeSignUp` when it
 * has no identifier of its own (a password or passkey method, whose identity
 * is the app user id its components key by). The core stores no account, so
 * the value only reaches the app's `createUser` callback; later sign-ins send
 * the user id as the account identifier.
 *
 * @TODO(nicolas) Consider dropping `accountId` from the app callbacks for
 * these sign-in methods, or making it optional, instead of sending a
 * placeholder.
 */
export const USE_USER_ID_AS_ACCOUNT_ID = "";

/**
 * The type of an app defined user-creating mutation: create the app's user
 * record for an identity the core has not seen before, and return its id. It
 * runs once per account, and {@link OnSignInFn} runs right after it, so this
 * one is only responsible for what is true at creation time.
 *
 * This is the core entrypoint for an application to integrate its user model
 * with Convex Auth. Apps install one per sign-in method, although the function that
 * is passed in may be shared across multiple methods if it is typed to
 * accept a union of them.
 *
 * The application keeps ownership of its users table. The core treats the
 * returned id as an opaque string at runtime; at the type level the table is
 * named by `setupConvexAuth`'s `usersTable` option, which is what makes the return
 * type `Id<usersTable>` rather than a bare string.
 */
export type CreateUserFn<
  ProviderName extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference_future<
  "mutation",
  "internal",
  {
    provider: {
      name: ProviderName;
      accountId: string;
      profile: Profile;
    };
  },
  GenericId<UsersTable>
>;

/**
 * The type of an app defined sign-in mutation: an optional hook that runs on
 * *every* sign-in.
 *
 * That includes the first one, where it runs immediately after
 * {@link CreateUserFn} has minted the user. So per-sign-in work (a last-seen
 * timestamp, an audit row, syncing the user record from the latest `profile`,
 * which the core does not store) belongs here and nowhere else.
 *
 * The core resolves the account to its app user first, so `userId` is always
 * present and there is nothing to return. Declare `returns: v.null()` and
 * return `null`, or leave the callback out entirely. Throw a `ConvexError` to
 * reject the sign in, which on a first sign-in rolls back the user the create
 * callback just made.
 */
export type OnSignInFn<
  ProviderName extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference_future<
  "mutation",
  "internal",
  {
    provider: {
      name: ProviderName;
      accountId: string;
      profile: Profile;
    };
    userId: GenericId<UsersTable>;
  },
  null
>;

/**
 * The app's user callbacks for one sign-in method, as its `attachUserCallbacks`
 * takes them: {@link CreateUserFn} is required (something has to create the
 * user record), {@link OnSignInFn} is optional.
 */
export type UserCallbacks<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = {
  createUser: CreateUserFn<Provider, Profile, UsersTable>;
  onSignIn?: OnSignInFn<Provider, Profile, UsersTable>;
};

/**
 * The helpers that `authMutation` injects onto `ctx` for a
 * method's handlers.
 *
 * This API is used for building sign-in methods.
 */
export type BoundAuthHelpers<Profile> = {
  /**
   * Mint the app user for a *new* identity and exchange it for a session.
   *
   * Call this when the sign-in method has verified an identity it has never
   * seen. The core calls the app's `createUser` to mint the app user, then
   * its `onSignIn` like any other sign-in, and returns the tokens a client
   * needs to make authenticated calls. The bundle carries the new `userId`,
   * which the sign-in method records against its identity in its own
   * component, in the same mutation.
   *
   * The core keeps no accounts, so it cannot tell a first sign-in from a
   * return visit: the sign-in method looks its identity up in its component
   * first and picks this helper or {@link BoundAuthHelpers.completeSignIn}.
   */
  completeSignUp(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<TokenBundle>;
  /**
   * Exchange a verified *existing* identity for a session.
   *
   * Call this once the sign-in method has authenticated a known identity its
   * own way (checking a password, say) and resolved it to its app user in its
   * own component. The core runs the app's `onSignIn` callback if one is
   * attached, and returns the tokens a client needs to make authenticated
   * calls.
   *
   * Reaching this helper is the sign-in method's assertion that `userId` is
   * the user the identity belongs to; the core does not check it.
   */
  completeSignIn(args: {
    userId: string;
    providerAccountId: string;
    profile: Profile;
  }): Promise<TokenBundle>;
  /**
   * Mint the app user for a verified identity, but do not mint a session.
   *
   * Call this when the user must complete a step (for example, an email
   * validation) before the first sign-in. The app's `createUser` mints the
   * user, as for `completeSignUp`; `onSignIn` does not run. The sign-in method
   * records the new `userId` against its identity in its component and signs
   * the user in later with `completeSignIn`.
   */
  signUpWithoutSession(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<{ userId: string }>;
  /**
   * Revokes every session of the signed-in user other than the current one
   * (the JWT's subject). Returns the number of active (non-expired)
   * sessions revoked; returns 0 when not authenticated. Expired sessions are
   * deleted as well, but not counted.
   *
   * NOTE: Callers should only invoke this function after verifying that the
   * logged in user truly owns the session, via confirming an authentication
   * method. Otherwise, the request might be originating from a stolen session,
   * which shouldn't be able to revoke other sessions.
   *
   * @internal until we solidify the full session lifecycle
   */
  revokeOtherSessions(): Promise<number>;
  /**
   * Revokes every session of the given user, including the caller's own if
   * it belongs to that user. Returns the number of active (non-expired)
   * sessions revoked. Expired sessions are deleted as well, but not counted.
   *
   * For flows that prove ownership of an account without a trusted current
   * session, such as password recovery. Revoke before minting the new
   * session, which this would otherwise revoke too.
   *
   * NOTE: This does no authorization. Callers should only invoke it after
   * proving that the requester owns `userId` (e.g. through an email
   * challenge).
   *
   * @internal until we solidify the full session lifecycle
   */
  revokeAllSessions(userId: string): Promise<number>;
};

/**
 * The ctx additions that `authMutation` provides to the handlers of a
 * method.
 *
 * The {@link BoundAuthHelpers} are available under `ctx.convexAuth`.
 */
export type ConvexAuthCtx<Profile> = {
  convexAuth: BoundAuthHelpers<Profile>;
};
