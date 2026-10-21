import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInComplete,
  vSignInError,
  USE_USER_ID_AS_ACCOUNT_ID,
} from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import type { ComponentApi } from "../../components/passkey/_generated/component.ts";
import type { ComponentApi as UsernameComponentApi } from "../../components/username/_generated/component.ts";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../../components/username/validation.ts";
import {
  finishAuthenticationUserError,
  finishRegistrationUserError,
  vAuthenticationResponseJSON,
  vPublicKeyCredentialCreationOptionsJSON,
  vPublicKeyCredentialRequestOptionsJSON,
  vRegistrationResponseJSON,
} from "../../components/passkey/validation.ts";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
} from "./options.ts";
import {
  finishAddPasskey,
  startAddPasskey,
  verifyAddPasskey,
} from "./management/add.ts";
import { listPasskeys } from "./management/list.ts";
import {
  finishRemovePasskey,
  startRemovePasskey,
} from "./management/remove.ts";
import { renamePasskey } from "./management/rename.ts";
import { SIGN_IN_PURPOSE } from "./purposes.ts";
import { defaultPasskeyName } from "./aaguids.ts";

/**
 * Options for {@link setupUsernamePasskey}.
 */
export type UsernamePasskeyOptions = {
  /**
   * The mounted passkey component (`components.authPasskey`). The recipe
   * drives its registration and authentication ceremonies.
   */
  component: ComponentApi;
  /**
   * The mounted username component (`components.authUsername`). The recipe
   * uses it to map a username onto the app user id: it stores the username
   * at sign-up and reads it back at sign-in.
   */
  usernameComponent: UsernameComponentApi;
  /**
   * The relying party ID: usually the registrable domain at which the app
   * is served (for example, "example.com" or "localhost"). Only web pages
   * on the same domain (or its subdomains) can use the passkeys.
   * See https://web.dev/articles/webauthn-rp-id
   */
  rpId: string;
  /**
   * The exact origin of the ceremonies (for example,
   * "https://app.example.com" or "http://localhost:5173").
   */
  origin: string;
  /**
   * The human-readable relying party name that the browser shows in the
   * passkey dialog. WebAuthn requires it on the client. When not set, the
   * `rpId` is used.
   */
  rpName?: string;
};

/**
 * {@link UsernamePasskeyOptions} with the defaults applied. The provider
 * functions, including the passkey-management ones, close over this
 * value.
 */
export type UsernamePasskeyConfig = Required<UsernamePasskeyOptions>;

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "passkey";

const startSignInResult = v.union(
  // The username has an account: authenticate with a passkey of that
  // account. The challenge is bound to the user.
  v.object({
    success: v.literal(true),
    step: v.literal("authenticate"),
    options: vPublicKeyCredentialRequestOptionsJSON,
  }),
  // The username is free: register a new account with a new passkey.
  v.object({
    success: v.literal(true),
    step: v.literal("register"),
    options: vPublicKeyCredentialCreationOptionsJSON,
  }),
  v.object({ success: v.literal(false), userError: setUsernameUserError }),
);

/**
 * The result of `startSignInWithUsernamePasskey`: which ceremony the client must run, with
 * the data for the WebAuthn call, or a user-facing `userError`.
 */
export type StartSignInResult = Infer<typeof startSignInResult>;

const startAutofillSignInResult = v.object({
  options: vPublicKeyCredentialRequestOptionsJSON,
});

/**
 * The result of `startAutofillSignInWithUsernamePasskey`: an unbound challenge for a
 * conditional-mediation (passkey autofill) `navigator.credentials.get()` call.
 */
export type StartAutofillSignInResult = Infer<typeof startAutofillSignInResult>;

const finishSignUpResult = v.union(
  vSignInComplete,
  vSignInError(v.union(finishRegistrationUserError, setUsernameUserError)),
);

/**
 * The result of `finishSignUpWithUsernamePasskey`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type FinishSignUpResult = Infer<typeof finishSignUpResult>;

const finishSignInResult = v.union(
  v.object({
    ...vSignInComplete.fields,
    // The username of the account, for display. `null` when the app
    // removed the username of the user.
    username: v.union(v.string(), v.null()),
  }),
  vSignInError(finishAuthenticationUserError),
);

/**
 * The result of `finishSignInWithUsernamePasskey`.
 *
 * When complete the minted session tokens and the username of the account,
 * otherwise a user-facing `userError`.
 */
export type FinishSignInResult = Infer<typeof finishSignInResult>;

/**
 * An identifier-first username + passkey recipe: the user types a username;
 * when the username has an account, the user authenticates with a passkey
 * of that account; when the username is free, the user registers a new
 * account immediately.
 *
 * Logged in users can add or remove passkeys.
 *
 * Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * const {
 *   startSignInWithUsernamePasskey,
 *   startAutofillSignInWithUsernamePasskey,
 *   finishSignUpWithUsernamePasskey,
 *   finishSignInWithUsernamePasskey,
 *
 *   listPasskeys,
 *   renamePasskey,
 *
 *   startAddPasskey,
 *   verifyAddPasskey,
 *   finishAddPasskey,
 *
 *   startRemovePasskey,
 *   finishRemovePasskey,
 * } = setupUsernamePasskey(auth, {
 *   component: components.authPasskey,
 *   usernameComponent: components.authUsername,
 *   rpId: "localhost",
 *   origin: "http://localhost:5173",
 * });
 * ```
 */
export function setupUsernamePasskey(
  core: AuthCore,
  options: UsernamePasskeyOptions,
) {
  const { component, usernameComponent, rpId, origin } = options;
  const rpName = options.rpName ?? rpId;
  const config: UsernamePasskeyConfig = { ...options, rpName };

  const { authMutation } = core.bindProvider<
    typeof PROVIDER_NAME,
    Record<string, never>
  >({
    name: PROVIDER_NAME,
  });

  return {
    /**
     * The identifier-first entry point: look the username up and start
     * the matching ceremony.
     *
     * - The username has an account: start an authentication ceremony
     *   that is bound to that user (`step: "authenticate"`).
     * - The username is free: start a registration ceremony for a new
     *   account (`step: "register"`). The account is not created here;
     *   `finishSignUpWithUsernamePasskey` creates everything in one transaction.
     *
     * Note: this flow lets an attacker enumerate which usernames exist.
     * That is intrinsic to identifier-first passkey sign-in (and account
     * existence is also observable through sign-up), so it is accepted.
     */
    startSignInWithUsernamePasskey: mutationGeneric({
      args: { username: v.string() },
      returns: startSignInResult,
      handler: async (ctx, { username }): Promise<StartSignInResult> => {
        // Reject a malformed username before any ceremony starts.
        const usernameError = validateUsernameFormat(username);
        if (usernameError !== null) {
          return { success: false, userError: usernameError };
        }

        const userId = await ctx.runQuery(
          usernameComponent.public.getUserIdByUsername,
          { username },
        );
        if (userId !== null) {
          // When the user has no passkeys (possible only if a flow outside
          // this provider deletes the last passkey of a user), this branch
          // returns an empty `allowCredentials` and the user can neither
          // sign in nor register again.
          // TODO: Should we throw an error instead?
          const { challenge, allowCredentials } = await ctx.runMutation(
            component.authentication.startAuthentication,
            { purpose: SIGN_IN_PURPOSE, userId },
          );
          return {
            success: true,
            step: "authenticate",
            options: buildAuthenticationOptions({
              rpId,
              challenge,
              allowCredentials,
            }),
          };
        }

        const { challenge, userHandle } = await ctx.runMutation(
          component.registration.startRegistrationForNewUser,
          {},
        );
        return {
          success: true,
          step: "register",
          options: buildRegistrationOptions({
            rpId,
            rpName,
            challenge,
            userHandle,
            // What the browser shows for the new passkey in its passkey manager.
            // TODO(nicolas) Think of how we could allow the app to customize this
            userName: username,
            userDisplayName: username,
            // A sign-up ceremony makes the first passkey of a brand-new
            // user, so there are no credentials to exclude.
            excludeCredentials: [],
          }),
        };
      },
    }),

    /**
     * Start a conditional-mediation (passkey autofill) ceremony: an
     * authentication challenge that is not bound to a user. The passkey
     * that the user selects identifies the account.
     */
    startAutofillSignInWithUsernamePasskey: mutationGeneric({
      args: {},
      returns: startAutofillSignInResult,
      handler: async (ctx): Promise<StartAutofillSignInResult> => {
        const { challenge } = await ctx.runMutation(
          component.authentication.startAuthentication,
          { purpose: SIGN_IN_PURPOSE },
        );
        return {
          options: buildAuthenticationOptions({
            rpId,
            challenge,
            allowCredentials: [],
          }),
        };
      },
    }),

    /**
     * Create a new account: the user, the username, the account, the
     * session, and the passkey, all in ONE mutation. When any step
     * fails, nothing is committed.
     *
     * The order of the steps gives that guarantee:
     * 1. Checks that write nothing: the username format, the username
     *    conflict, and `checkRegistrationForNewUser` (the full WebAuthn
     *    verification as a query). Each failure, correctable or not,
     *    returns a `userError` here, before anything exists.
     * 2. Writes that cannot fail after the checks: `completeSignUp` mints
     *    the user, the account, and the session, `setUsername` stores the
     *    username, and `finishRegistrationForNewUser` stores the
     *    passkey. None of
     *    them can fail after step 1 inside the same transaction, so a
     *    failure throws and rolls everything back.
     */
    finishSignUpWithUsernamePasskey: authMutation({
      args: {
        username: v.string(),
        response: vRegistrationResponseJSON,
      },
      returns: finishSignUpResult,
      handler: async (ctx, args): Promise<FinishSignUpResult> => {
        const { username } = args;
        const usernameError = validateUsernameFormat(username);
        if (usernameError !== null) {
          return { status: "error", userError: usernameError };
        }

        // Fail early if the username is taken
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

        // The app does not name a new passkey yet, thus the provider
        // names it after the authenticator model.
        // TODO(nicolas) Allow the user to provide a custom name when creating a passkey
        const passkeyName = defaultPasskeyName(args.response);

        // Fail early if the passkey registration fails
        const checkResult = await ctx.runQuery(
          component.registration.checkRegistrationForNewUser,
          {
            expectedRpId: rpId,
            expectedOrigin: origin,
            response: args.response,
            name: passkeyName,
          },
        );
        if (!checkResult.success) {
          const { userError } = checkResult;
          if (userError.error === "INVALID_NAME") {
            // Not possible: the only name that this function passes is a
            // default name, and every default name is a short label that
            // the component stores. See the same case in
            // `finishAddPasskey`.
            throw new Error(
              "Unexpected error when storing the passkey: INVALID_NAME",
              { cause: userError },
            );
          }
          return { status: "error", userError };
        }

        // Create the account + app user (via the app's createUser) and
        // mint the session.
        //
        // TODO(nicolas) The app's user callbacks should not receive a
        // provider account ID for this provider at all: the value is an
        // internal key ("" at sign-up, the user id afterwards) with no
        // meaning to the app. We will probably improve this when
        // providers support typesafe profiles.
        const tokens = await ctx.convexAuth.completeSignUp({
          providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
          profile: {},
        });

        const setUsernameResult = await ctx.runMutation(
          usernameComponent.public.setUsername,
          { userId: tokens.userId, username },
        );
        if (!setUsernameResult.success) {
          // Not possible: the username format was validated and the
          // username was free above, in the same transaction. Throwing
          // rolls everything back.
          throw new Error(
            "Unexpected error when setting the username: " +
              setUsernameResult.userError.error,
            { cause: setUsernameResult.userError },
          );
        }

        // Store the verified credential, link the handle to the new
        // user, and consume the challenge.
        const registrationResult = await ctx.runMutation(
          component.registration.finishRegistrationForNewUser,
          {
            expectedRpId: rpId,
            expectedOrigin: origin,
            newUserId: tokens.userId,
            response: args.response,
            name: passkeyName,
          },
        );
        if (!registrationResult.success) {
          // Not possible: `checkRegistrationForNewUser` succeeded
          // above, in the same transaction. Throwing rolls everything
          // back.
          throw new Error(
            "Unexpected error when storing the passkey: " +
              registrationResult.userError.error,
            { cause: registrationResult.userError },
          );
        }

        return { status: "complete", tokens };
      },
    }),

    /**
     * Verify a passkey assertion and, on success, mint a session.
     *
     * The function serves both ceremonies that produce an assertion: the
     * username-first branch (`startSignInWithUsernamePasskey` → `step: "authenticate"`, a
     * challenge bound to the user) and passkey autofill
     * (`startAutofillSignInWithUsernamePasskey`, an unbound challenge where the credential
     * identifies the user).
     */
    finishSignInWithUsernamePasskey: authMutation({
      args: {
        response: vAuthenticationResponseJSON,
      },
      returns: finishSignInResult,
      handler: async (ctx, args): Promise<FinishSignInResult> => {
        const authenticationResult = await ctx.runMutation(
          component.authentication.finishAuthentication,
          {
            purpose: SIGN_IN_PURPOSE,
            expectedRpId: rpId,
            expectedOrigin: origin,
            response: args.response,
          },
        );
        if (!authenticationResult.success) {
          return {
            status: "error",
            userError: authenticationResult.userError,
          };
        }

        const { userId } = authenticationResult;
        const username = await ctx.runQuery(
          usernameComponent.public.getUsername,
          { userId },
        );

        const tokens = await ctx.convexAuth.completeSignIn({
          providerAccountId: userId,
          profile: {},
        });
        return { status: "complete", tokens, username };
      },
    }),

    // The passkey-management functions of a signed-in user.
    //
    // TODO(nicolas) These functions do not compose with the other auth
    // providers yet. They assume that a passkey is the only way into the
    // account: `startAddPasskey` re-authenticates with an existing
    // passkey, thus a user who signed in with a different provider and
    // has no passkey cannot add a first one; and `finishRemovePasskey`
    // refuses the last passkey, even when the user keeps another way to
    // sign in.
    //
    // None of them mints a session, thus none of them goes through
    // `authMutation`. Each one resolves the caller with the session of
    // the request and refuses a signed-out caller. Each mutation
    // composes the functions of the component in one transaction.
    listPasskeys: listPasskeys(config),
    renamePasskey: renamePasskey(config),
    startAddPasskey: startAddPasskey(config),
    verifyAddPasskey: verifyAddPasskey(config),
    finishAddPasskey: finishAddPasskey(config),
    startRemovePasskey: startRemovePasskey(config),
    finishRemovePasskey: finishRemovePasskey(config),
  };
}
