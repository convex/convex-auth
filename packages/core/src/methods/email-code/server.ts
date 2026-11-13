/**
 * The `emailCode` method: sign in with a short code sent by email, with no
 * password. The same two steps sign up a new user and sign in an existing
 * one.
 *
 * @module
 */
import { createFunctionHandle } from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInComplete,
  vSignInError,
  type UserCallbacks,
} from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import type { ComponentApi } from "../../components/email/_generated/component.js";
import {
  completeCodeChallengeUserError,
  startChallengeUserError,
  type EmailSenderConfig,
} from "../../components/email/validation.ts";
import type { EmailSenderOptions } from "../email-password/server.ts";

export type { EmailSenderOptions } from "../email-password/server.ts";

/** The name of this sign-in method. The app's user callbacks get it as `method.name`. */
const METHOD_NAME = "emailCode";

/**
 * Options for {@link setupEmailCode}.
 */
export type EmailCodeOptions = {
  /**
   * The mounted email component (`components.authEmail`). The method uses it
   * to find the user of an address and to run the challenges.
   */
  component: ComponentApi;
  /** How the method sends emails. */
  emailSender: EmailSenderOptions;
  /**
   * The number of digits of the code, from 6 to 10. The default is 8. See the
   * docs for how the length bounds the chance of a guess.
   */
  codeLength?: number;
  /**
   * How long a code works, in milliseconds, from 1 to 30 minutes. The default
   * is 10 minutes.
   */
  ttlMs?: number;
  /** The first lines of the email. */
  email?: {
    /**
     * The subject. `{code}` is replaced by the code. The default is
     * `"{code} is your sign-in code"`: a code in the subject shows in the
     * notification, and some phones offer to fill it in.
     */
    subject?: string;
    /**
     * The line above the code. The default is `"Enter this code to sign
     * in:"`.
     */
    intro?: string;
  };
};

/**
 * The profile that the method gives to the app's `createUser` and `onSignIn`:
 * the address that received the code, as the user typed it, or as its owner
 * verified it.
 */
export const vEmailCodeProfile = v.object({ email: v.string() });

/** The profile of the `emailCode` method. See {@link vEmailCodeProfile}. */
export type EmailCodeProfile = Infer<typeof vEmailCodeProfile>;

const startResult = v.union(
  v.object({ success: v.literal(true), browserSecret: v.string() }),
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);

/**
 * The result of `startSignInWithEmailCode`. On success, the secret that the
 * browser must keep for `completeSignInWithEmailCode`.
 */
export type StartSignInWithEmailCodeResult = Infer<typeof startResult>;

const completeResult = v.union(
  vSignInComplete,
  vSignInError(completeCodeChallengeUserError),
);

/** The result of `completeSignInWithEmailCode`: the minted session tokens, or an error. */
export type CompleteSignInWithEmailCodeResult = Infer<typeof completeResult>;

/**
 * Throw when the completion of a challenge failed after `check` passed, in
 * the same transaction. It cannot happen, and throwing rolls back the
 * session and any new user.
 */
function throwUnlessCompleted(
  result: { success: true } | { success: false; userError: { error: string } },
): void {
  if (!result.success) {
    throw new Error(
      "Unexpected error when completing the sign-in challenge: " +
        result.userError.error,
      { cause: result.userError },
    );
  }
}

/**
 * A sign-in method where the user types a short code sent to their email
 * address. Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * import { components, internal } from "./_generated/api";
 * import { env } from "./_generated/server";
 * import { setupConvexAuth } from "@convex-dev/auth/server";
 * import { setupEmailCode } from "@convex-dev/auth/methods/email-code/server";
 *
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { startSignInWithEmailCode, completeSignInWithEmailCode } =
 *   setupEmailCode(auth, {
 *     component: components.authEmail,
 *     emailSender: {
 *       kind: "resend",
 *       sendEmail: components.resend.lib.sendEmail,
 *       apiKey: env.RESEND_API_KEY,
 *       from: "My App <auth@example.com>",
 *     },
 *   }).attachUserCallbacks({
 *     createUser: internal.users.createUserEmailCode,
 *   });
 * ```
 *
 * - `startSignInWithEmailCode` sends the code, and gives the same result
 *   whether or not the address has an account.
 * - `completeSignInWithEmailCode` checks the code and signs in the user that
 *   has verified the address, whichever method they signed up with. When no
 *   user has, it creates one with the app's `createUser`, and records the
 *   address as its primary email address.
 * - A code works once, only in the browser that asked for it, for 10
 *   minutes by default. The fifth wrong code deletes the challenge.
 */
export function setupEmailCode<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: EmailCodeOptions,
) {
  const { component, emailSender, codeLength, ttlMs } = options;

  /**
   * The sender config the email component's `start` mutations accept.
   *
   * This is a function because `createFunctionHandle` is asynchronous, and
   * it works only while a Convex function runs, not when `convex/auth.ts`
   * is imported and this setup runs.
   */
  const senderConfig = async (): Promise<EmailSenderConfig> => ({
    kind: "resend",
    sendEmailHandle: await createFunctionHandle(emailSender.sendEmail),
    from: emailSender.from,
    apiKey: emailSender.apiKey,
    // TODO: make these values configurable.
    initialBackoffMs: 30 * 1000,
    retryAttempts: 5,
  });

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get the functions of this method to export.
     */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<typeof METHOD_NAME, EmailCodeProfile, UsersTable>) {
      const { authMutation } = core.bindMethod({
        name: METHOD_NAME,
        createUser,
        onSignIn,
      });

      return {
        /**
         * Send a sign-in code to `email`. The result is the same whether or
         * not a user has verified the address. It fails only for a malformed
         * address, or when the address or the client has asked for too many
         * codes.
         */
        startSignInWithEmailCode: authMutation({
          args: { email: v.string() },
          returns: startResult,
          handler: async (
            ctx,
            { email },
          ): Promise<StartSignInWithEmailCodeResult> => {
            const start = await ctx.runMutation(
              component.challenge.signIn.start,
              {
                email,
                emailSender: await senderConfig(),
                codeLength,
                ttlMs,
                subject: options.email?.subject,
                intro: options.email?.intro,
              },
            );
            if (!start.success) {
              return start;
            }
            return { success: true, browserSecret: start.browserSecret };
          },
        }),

        /**
         * Check the code from the email with the secret from the starting
         * browser, and mint a session. The user that has verified the
         * address signs in; when no user has, the app's `createUser` creates
         * one, and the address becomes its primary email address. Everything
         * happens in one transaction.
         *
         * A wrong code returns `INCORRECT_CODE` and uses one attempt; the
         * fifth returns `TOO_MANY_ATTEMPTS` and deletes the challenge. An
         * expired, used, or unknown challenge returns `INVALID_CHALLENGE`.
         */
        completeSignInWithEmailCode: authMutation({
          args: { code: v.string(), browserSecret: v.string() },
          returns: completeResult,
          handler: async (
            ctx,
            { code, browserSecret },
          ): Promise<CompleteSignInWithEmailCodeResult> => {
            // A wrong code must return, not throw: the count of attempts
            // commits only with the transaction.
            const check = await ctx.runMutation(
              component.challenge.signIn.check,
              { code, browserSecret },
            );
            if (!check.success) {
              return { status: "error", userError: check.userError };
            }
            const profile = { email: check.email };

            if (check.userId !== null) {
              const complete = await ctx.runMutation(
                component.challenge.signIn.complete,
                { code, browserSecret },
              );
              throwUnlessCompleted(complete);
              const tokens = await ctx.convexAuth.completeSignIn({
                userId: check.userId,
                profile,
                authenticatedBy: component,
              });
              return { status: "complete", tokens };
            }

            const tokens = await ctx.convexAuth.completeSignUp({
              profile,
              authenticatedBy: component,
            });
            const complete = await ctx.runMutation(
              component.challenge.signIn._internal_dangerous_completeForNewUser,
              { code, browserSecret, newUserId: tokens.userId },
            );
            throwUnlessCompleted(complete);
            return { status: "complete", tokens };
          },
        }),
      };
    },
  };
}
