import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../server/userId.ts";
import {
  vSignInComplete,
  vSignInError,
  USE_USER_ID_AS_ACCOUNT_ID,
  type UserCallbacks,
} from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import type { ComponentApi } from "../../components/password/_generated/component.ts";
import type { ComponentApi as UsernameComponentApi } from "../../components/username/_generated/component.ts";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../../components/username/validation.ts";
import {
  validateNewPassword,
  setPasswordUserError,
  verifyPasswordUserError,
} from "../../components/password/validation.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "password";

/**
 * Options for {@link setupUsernamePassword}.
 */
export type UsernamePasswordOptions = {
  /**
   * The mounted password component (`components.authPassword`). The
   * recipe drives its `setPassword` / `verifyPassword` mutations.
   */
  component: ComponentApi;
  /**
   * The mounted username component (`components.authUsername`). The recipe
   * uses it to map a username onto the app user id: it stores the username
   * at sign-up and reads it back at sign-in.
   */
  usernameComponent: UsernameComponentApi;
};

const signInResult = v.union(
  vSignInComplete,
  vSignInError(
    v.union(
      verifyPasswordUserError,
      v.object({ error: v.literal("USER_NOT_FOUND") }),
    ),
  ),
);

/**
 * The result of `signInWithUsernamePassword`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type SignInResult = Infer<typeof signInResult>;

const signUpResult = v.union(
  vSignInComplete,
  vSignInError(v.union(setPasswordUserError, setUsernameUserError)),
);

/**
 * The result of `signUpWithUsernamePassword`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type SignUpResult = Infer<typeof signUpResult>;

const changePasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      v.object({ error: v.literal("NOT_SIGNED_IN") }),
      v.object({ error: v.literal("INVALID_CREDENTIALS") }),
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
      setPasswordUserError,
    ),
  }),
);

/**
 * The result of `changePassword`.
 *
 * `INVALID_CREDENTIALS` and `RATE_LIMITED` are about the current password.
 * The other errors are about the new password.
 */
export type ChangePasswordResult = Infer<typeof changePasswordResult>;

/**
 * The simplest password recipe: every account is a `(username, password)` pair,
 * with no email or email verification. Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword } =
 *   setupUsernamePassword(auth, {
 *     component: components.authPassword,
 *     usernameComponent: components.authUsername,
 *   }).attachUserCallbacks({ createUser: internal.users.createUserPassword });
 * ```
 *
 * The app re-exports the returned `signUpWithUsernamePassword` / `signInWithUsernamePassword`
 * / `changePassword` mutations so its clients can call them.
 *
 * Account resolution (username → app user id) is owned by the username
 * component: the method stores the username there at sign-up, and reads the
 * user id back from it at sign-in. The password component itself stores only
 * `{ userId, passwordHash }` and knows nothing about usernames.
 */
export function setupUsernamePassword<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: UsernamePasswordOptions,
) {
  const { component, usernameComponent } = options;

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get the functions of this method to export.
     */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<"password", Record<string, never>, UsersTable>) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser,
        onSignIn,
      });

      return {
        /**
         * Create a new account: reject a taken username or an invalid password,
         * otherwise create the user + session and store the username and the
         * password.
         */
        signUpWithUsernamePassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: signUpResult,
          handler: async (
            ctx,
            { username, password },
          ): Promise<SignUpResult> => {
            // Validate the username and the password *before* creating
            // anything, so invalid input never mints a session.
            // (`setUsername` and `setPassword` do the same checks again, but by
            // then the account would already exist.)
            // TODO(nicolas) Make the first-party methods apply stronger validation rules by default
            const usernameError = validateUsernameFormat(username);
            if (usernameError !== null) {
              return { status: "error", userError: usernameError };
            }
            const userError = validateNewPassword(password);
            if (userError !== null) {
              return { status: "error", userError };
            }

            const existing = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (existing !== null) {
              return {
                status: "error",
                userError: { error: "USERNAME_TAKEN" },
              };
            }

            // Create the account + app user (via the app's createUser) and
            // mint the session. Password accounts are keyed by the app user id,
            // which does not exist before this call mints it, hence the
            // placeholder; sign-in passes the user id itself.
            //
            // TODO(nicolas) The app's user callbacks should not receive a
            // provider account ID for the `usernamePassword` method at all: the value
            // is an internal key ("" at sign-up, the user id afterwards) with
            // no meaning to the app. We will probably improve this when
            // methods support typesafe profiles.
            const tokens = await ctx.convexAuth.completeSignUp({
              providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
              profile: {},
            });

            const setUsernameResult = await ctx.runMutation(
              usernameComponent.public.setUsername,
              { userId: tokens.userId, username },
            );
            if (!setUsernameResult.success) {
              // Unexpected: we validated the username above, and this handler
              // is a mutation, thus the check for a conflict above and this
              // call are in the same transaction.
              // Throwing so that the transaction doesn’t commit.
              throw new Error(
                "Unexpected error when setting the username: " +
                  setUsernameResult.userError.error,
                { cause: setUsernameResult.userError },
              );
            }

            const setResult = await ctx.runMutation(
              component.public.setPassword,
              {
                userId: tokens.userId,
                password,
              },
            );
            if (!setResult.success) {
              // Unexpected: we pre-validated the password above,
              // so this call should not fail.
              // Throwing so that the transaction doesn’t commit.
              //
              // TODO(nicolas) can we improve this?
              throw new Error(
                "Unexpected error when setting the password: " + userError,
                { cause: userError },
              );
            }

            return { status: "complete", tokens };
          },
        }),

        /**
         * Verify an existing account's password and, on success, mint a session.
         * Returns `USER_NOT_FOUND` when the username has no account and
         * `INVALID_CREDENTIALS` when the password is wrong, so callers can tell
         * the two apart. (Account existence is already observable via sign-up's
         * `USERNAME_TAKEN`, so distinguishing them here leaks nothing new.)
         */
        signInWithUsernamePassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: signInResult,
          handler: async (
            ctx,
            { username, password },
          ): Promise<SignInResult> => {
            const userId = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (userId === null) {
              return {
                status: "error",
                userError: { error: "USER_NOT_FOUND" },
              };
            }

            const verifyResult = await ctx.runMutation(
              component.public.verifyPassword,
              { userId, password },
            );
            if (!verifyResult.success) {
              return { status: "error", userError: verifyResult.userError };
            }

            // The username resolved to a user id and its password verified, so
            // the account exists and `completeSignIn` (which throws otherwise)
            // is the right helper.
            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: {},
            });
            return { status: "complete", tokens };
          },
        }),

        /**
         * Change the password of the signed-in user. The user must re-authenticate
         * by giving their current password.
         */
        changePassword: mutationGeneric({
          args: { currentPassword: v.string(), newPassword: v.string() },
          returns: changePasswordResult,
          handler: async (
            ctx,
            { currentPassword, newPassword },
          ): Promise<ChangePasswordResult> => {
            const userId = await getAuthUserId(ctx);
            if (userId === null) {
              return { success: false, userError: { error: "NOT_SIGNED_IN" } };
            }

            // Validate the new password before verifying the current one, so
            // that invalid new password are ignored by the rate limit.
            const newPasswordError = validateNewPassword(newPassword);
            if (newPasswordError !== null) {
              return { success: false, userError: newPasswordError };
            }

            // TODO(nicolas) This does not compose with other sign-in
            // methods yet: we require users to reauthenticate with their
            // current password, so this doesn’t allow users who don’t have
            // a password at this point to add a password to their account.
            const verifyResult = await ctx.runMutation(
              component.public.verifyPassword,
              { userId, password: currentPassword },
            );
            if (!verifyResult.success) {
              if (verifyResult.userError.error === "RATE_LIMITED") {
                return { success: false, userError: verifyResult.userError };
              }
              // `verifyPassword` also reports format errors. Here we use
              // INVALID_CREDENTIALS for all current password formatting errors,
              // so that the user doesn’t think that there is an issue
              // in their new password.
              verifyResult.userError.error satisfies
                | "PASSWORD_TOO_SHORT"
                | "PASSWORD_TOO_LONG"
                | "PASSWORD_HAS_SURROUNDING_WHITESPACE"
                | "INVALID_CREDENTIALS";
              return {
                success: false,
                userError: { error: "INVALID_CREDENTIALS" },
              };
            }

            const setResult = await ctx.runMutation(
              component.public.setPassword,
              { userId, password: newPassword },
            );
            if (!setResult.success) {
              // Unexpected: we pre-validated the new password above.
              throw new Error(
                "Unexpected error when setting the password: " +
                  setResult.userError.error,
                { cause: setResult.userError },
              );
            }

            // TODO(nicolas) Allow the user to choose to revoke their existing sessions here (needs core support)
            return { success: true };
          },
        }),
      };
    },
  };
}
