import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInComplete,
  vSignInError,
  type OnSignInFn,
} from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import { validateMaxAgeSeconds } from "../../server/reauthentication.ts";
import type { ComponentApi } from "../../components/passkey/_generated/component.ts";
import {
  finishAuthenticationUserError,
  validateExpectedOrigin,
  vAuthenticationResponseJSON,
  vPublicKeyCredentialRequestOptionsJSON,
} from "../../components/passkey/validation.ts";
import { buildAuthenticationOptions } from "../username-passkey/options.ts";
import { listPasskeys } from "../username-passkey/management/list.ts";
import { renamePasskey } from "../username-passkey/management/rename.ts";
import {
  finishPasskeyReauthentication,
  startPasskeyReauthentication,
} from "../username-passkey/management/reauthenticate.ts";
import {
  finishAddPasskey,
  removePasskey,
  startAddPasskey,
  type GetUserNameFn,
  type PasskeyManagementConfig,
} from "./management.ts";
import { REAUTHENTICATE_PURPOSE, SIGN_IN_PURPOSE } from "./purposes.ts";

export type {
  FinishAddPasskeyResult,
  GetUserNameFn,
  PasskeyUserName,
  RemovePasskeyResult,
  StartAddPasskeyResult,
} from "./management.ts";

/** By default, a user who changes their passkeys must have authenticated in the last 10 minutes. */
const DEFAULT_MAX_AUTHENTICATION_AGE_SECONDS = 10 * 60;

/**
 * Options for {@link setupPasskey}.
 */
export type PasskeyOptions = {
  /**
   * The mounted passkey component (`components.authPasskey`). The method
   * drives its registration and authentication ceremonies.
   */
  component: ComponentApi;
  /**
   * The relying party ID: usually the registrable domain at which the app
   * is served (for example, "example.com" or "localhost"). Only web pages
   * on the same domain (or its subdomains) can use the passkeys.
   * See https://web.dev/articles/webauthn-rp-id
   */
  rpId: string;
  /**
   * The exact origin of the ceremonies (for example,
   * "https://app.example.com" or "http://localhost:5173"), or a list of the
   * accepted origins. See the same option of `setupUsernamePasskey`.
   */
  origin: string | string[];
  /**
   * The human-readable relying party name that the browser shows in the
   * passkey dialog. When not set, the `rpId` is used.
   */
  rpName?: string;
  /**
   * How long ago, in seconds, the user may have last authenticated to add or
   * remove a passkey. A sign-in counts, and so does a re-authentication with
   * a passkey. Defaults to 10 minutes.
   */
  maxAuthenticationAgeSeconds?: number;
};

/**
 * The app's callbacks for the `passkey` method, as its `attachUserCallbacks`
 * takes them.
 */
export type PasskeyUserCallbacks<UsersTable extends string = string> = {
  /** Names the user for a new passkey. See {@link GetUserNameFn}. */
  getUserName: GetUserNameFn<UsersTable>;
  /** Runs on every sign-in with a passkey. See {@link OnSignInFn}. */
  onSignIn?: OnSignInFn<typeof METHOD_NAME, Record<string, never>, UsersTable>;
};

/** The name of this sign-in method. The app's `onSignIn` gets it as `method.name`. */
const METHOD_NAME = "passkey";

const startSignInResult = v.object({
  options: vPublicKeyCredentialRequestOptionsJSON,
});

/**
 * The result of `startSignInWithPasskey`: an unbound challenge, for a
 * `navigator.credentials.get()` call from a button or from autofill.
 */
export type StartSignInWithPasskeyResult = Infer<typeof startSignInResult>;

const finishSignInResult = v.union(
  vSignInComplete,
  vSignInError(finishAuthenticationUserError),
);

/**
 * The result of `finishSignInWithPasskey`: the minted session tokens, or a
 * user-facing `userError`.
 */
export type FinishSignInWithPasskeyResult = Infer<typeof finishSignInResult>;

/**
 * Passkeys for an account that another method created, for example with an
 * email and a password. The user adds a passkey once signed in, and then
 * signs in with it, from a button or from the autofill of a sign-in form,
 * without typing anything. The passkey identifies the account.
 *
 * This method never creates a user, so it has no `createUser` callback.
 * `getUserName` names the user for a new passkey.
 *
 * Adding and removing a passkey need a recent authentication of the session,
 * see `maxAuthenticationAgeSeconds`. Users can re-authenticate with a
 * passkey before a sensitive action (see `requireRecentAuthentication`).
 *
 * Wire it up in its own module, for example `convex/passkey.ts`, so that its
 * function names do not collide with the ones of another method:
 *
 * ```ts
 * // convex/passkey.ts. `convex/auth.ts` exports the result of
 * // `setupConvexAuth` as `auth`.
 * import { auth } from "./auth";
 *
 * export const {
 *   startSignInWithPasskey,
 *   finishSignInWithPasskey,
 *
 *   listPasskeys,
 *   renamePasskey,
 *   startAddPasskey,
 *   finishAddPasskey,
 *   removePasskey,
 *
 *   startPasskeyReauthentication,
 *   finishPasskeyReauthentication,
 * } = setupPasskey(auth, {
 *   component: components.authPasskey,
 *   rpId: "localhost",
 *   origin: "http://localhost:5173",
 * }).attachUserCallbacks({ getUserName: internal.users.passkeyUserName });
 * ```
 */
export function setupPasskey<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: PasskeyOptions,
) {
  const { component, rpId, origin } = options;
  validateExpectedOrigin(origin);
  const maxAuthenticationAgeSeconds =
    options.maxAuthenticationAgeSeconds ??
    DEFAULT_MAX_AUTHENTICATION_AGE_SECONDS;
  validateMaxAgeSeconds(
    maxAuthenticationAgeSeconds,
    "maxAuthenticationAgeSeconds",
  );
  const rpName = options.rpName ?? rpId;
  const coreComponent = core.component;
  const reauthenticationConfig = {
    component,
    coreComponent,
    rpId,
    origin,
    purpose: REAUTHENTICATE_PURPOSE,
  };

  return {
    /**
     * Supply the app's callbacks (see {@link PasskeyUserCallbacks}) and get
     * the functions of this method to export.
     */
    attachUserCallbacks({
      getUserName,
      onSignIn,
    }: PasskeyUserCallbacks<UsersTable>) {
      // No `createUser`: a passkey only signs in a user that exists.
      const { authMutation } = core.bindMethod({
        name: METHOD_NAME,
        onSignIn,
      });
      const config: PasskeyManagementConfig = {
        component,
        coreComponent,
        rpId,
        rpName,
        origin,
        maxAuthenticationAgeSeconds,
        getUserName: getUserName as GetUserNameFn,
      };

      return {
        /**
         * Start a sign-in: an authentication challenge that is not bound to
         * a user. The passkey that the user picks identifies the account.
         * The same options serve a button (a modal `get()` call) and
         * autofill (a conditional `get()` call).
         */
        startSignInWithPasskey: mutationGeneric({
          args: {},
          returns: startSignInResult,
          handler: async (ctx): Promise<StartSignInWithPasskeyResult> => {
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
         * Verify a passkey assertion and, on success, mint a session for
         * the owner of the passkey.
         */
        finishSignInWithPasskey: authMutation({
          args: { response: vAuthenticationResponseJSON },
          returns: finishSignInResult,
          handler: async (
            ctx,
            args,
          ): Promise<FinishSignInWithPasskeyResult> => {
            // Consumes the challenge whatever the outcome.
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
            const tokens = await ctx.convexAuth.completeSignIn({
              userId: authenticationResult.userId,
              profile: {},
              authenticatedBy: component,
            });
            return { status: "complete", tokens };
          },
        }),

        // The passkey-management functions of a signed-in user. None of
        // them mints a session. Each one resolves the caller with the
        // session of the request and refuses a signed-out caller.
        listPasskeys: listPasskeys(config),
        renamePasskey: renamePasskey(config),
        startAddPasskey: startAddPasskey(config),
        finishAddPasskey: finishAddPasskey(config),
        removePasskey: removePasskey(config),

        // Re-authenticate the signed-in user with one of their passkeys, and
        // record it on the current session, for
        // `requireRecentAuthentication`.
        startPasskeyReauthentication: startPasskeyReauthentication(
          reauthenticationConfig,
        ),
        finishPasskeyReauthentication: finishPasskeyReauthentication(
          reauthenticationConfig,
          authMutation,
        ),
      };
    },
  };
}
