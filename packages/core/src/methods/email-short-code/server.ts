/**
 * The `emailShortCode` method: a person signs in with a short code that they
 * receive by email and type in the app. There is no password, and one form
 * serves both sign-up and sign-in.
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
  startChallengeUserError,
  completeShortCodeUserError,
  originProblem,
  toShortCodeUserError,
  type EmailSenderConfig,
} from "../../components/email/validation.ts";
import type { SendEmailRef } from "../../components/email/helpers.ts";

/** The name of this sign-in method. The app's user callbacks get it as `method.name`. */
const METHOD_NAME = "emailShortCode";

/**
 * The purpose of the `custom` challenge that a sign-in starts. The name
 * carries a prefix so that an application's own custom purposes cannot
 * collide with it.
 */
const SIGN_IN_PURPOSE = "convexAuth/emailShortCode/signIn";

/**
 * How long a sign-in code stays valid. OWASP ASVS v5 6.5.5 requires at most
 * 10 minutes for an out-of-band authentication request.
 */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;

// TODO: let applications customize this copy.
const SIGN_IN_EMAIL = {
  // The email component puts the code before the subject:
  // "04718295 is your code: Sign in".
  subject: "Sign in",
  intro: "Enter this code to sign in:",
};

/**
 * How the method sends the sign-in emails.
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component. Mount that component in the app and pass its `sendEmail`
 * reference and your Resend API key here.
 */
export type EmailSenderOptions = {
  kind: "resend";
  /** The mounted Resend component's `lib.sendEmail` reference. */
  sendEmail: SendEmailRef;
  /**
   * The Resend API key. Read it from an environment variable of the
   * deployment (e.g. `env.RESEND_API_KEY`) rather than writing it in the
   * source.
   */
  apiKey: string;
  /**
   * The From address, e.g. `"My App <auth@example.com>"`. The address must be
   * on a domain you verified with Resend.
   */
  from: string;
};

/**
 * Options for {@link setupEmailShortCode}.
 */
export type EmailShortCodeOptions = {
  /**
   * The mounted email component (`components.authEmail`). The method uses it
   * to track verified emails and to run the challenges.
   */
  component: ComponentApi;
  /** How the method sends emails. */
  emailSender: EmailSenderOptions;
  /**
   * The origin of the page where the user types the code, for example
   * `"https://app.example.com"`: `https` (or `http` on localhost), with no
   * path and no trailing slash.
   *
   * The email gives it in the `OTP-Token` header (draft-goto-otp-token).
   * A mail client that supports the header offers the code for autofill
   * only on this origin.
   */
  origin: string;
};

const sendResult = v.union(
  v.object({ success: v.literal(true), browserSecret: v.string() }),
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);

/**
 * The result of `sendEmailShortCode`. On success, the secret the browser
 * must keep for `signInWithEmailShortCode`. The result does not tell whether
 * the address has an account.
 */
export type SendResult = Infer<typeof sendResult>;

const signInResult = v.union(
  vSignInComplete,
  vSignInError(completeShortCodeUserError),
);

/**
 * The result of `signInWithEmailShortCode`: the minted session tokens, or an
 * error.
 *
 * - `INCORRECT_CODE`: the code is not the code of the newest email.
 *   `attemptsLeft` tells how many more codes the sign-in accepts. At `0`,
 *   the user must ask for a new code.
 * - `RATE_LIMITED`: the address got too many incorrect codes recently. Try
 *   again after `retryAfterMs`.
 * - `INVALID_CHALLENGE`: no sign-in is in progress for this browser. The code
 *   expired, was used, or got too many incorrect attempts. Ask for a new
 *   code.
 */
export type SignInResult = Infer<typeof signInResult>;

export type EmailShortCodeProfile = Record<string, never>;

/**
 * A sign-in method where a person signs in with an 8-digit code received by
 * email. One form serves both a person who has an account and a person who
 * has none. Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * import { components, internal } from "./_generated/api";
 * import { env } from "./_generated/server";
 * import { setupConvexAuth } from "@convex-dev/auth/server";
 * import { setupEmailShortCode } from "@convex-dev/auth/methods/email-short-code/server";
 *
 * // The frontend origin where the user types the code.
 * const SITE_URL = env.SITE_URL ?? "http://localhost:5173";
 *
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { sendEmailShortCode, signInWithEmailShortCode } =
 *   setupEmailShortCode(auth, {
 *     component: components.authEmail,
 *     emailSender: {
 *       kind: "resend",
 *       sendEmail: components.resend.lib.sendEmail,
 *       apiKey: env.RESEND_API_KEY,
 *       from: "My App <auth@example.com>",
 *     },
 *     origin: SITE_URL,
 *   }).attachUserCallbacks({
 *     createUser: internal.users.createUserEmailShortCode,
 *   });
 * ```
 *
 * - `sendEmailShortCode` sends the code. It creates no user, and it gives
 *   the same result whether the address has an account or not.
 * - `signInWithEmailShortCode` signs in the user that has verified the
 *   address. When no user has, it creates one with the app's `createUser`,
 *   and records the address as its primary email address.
 * - A code works once, for 10 minutes, and only in the browser that asked
 *   for it: the browser must also send its secret. Thus a code that another
 *   person reads (for example on a lock screen) is not sufficient to sign
 *   in.
 * - A sign-in accepts 5 incorrect codes, and an address accepts 10
 *   incorrect codes per hour for all of its sign-ins together.
 */
export function setupEmailShortCode<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: EmailShortCodeOptions,
) {
  const { component, emailSender, origin } = options;
  // Validate the origin now, so a mistake fails at deploy time rather than
  // in the first email.
  const problem = originProblem(origin);
  if (problem !== null) {
    throw new Error(
      `setupEmailShortCode: origin ${problem}: ${origin}. Give the origin ` +
        `of the page where the user types the code, for example ` +
        `"https://app.example.com".`,
    );
  }

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
    }: UserCallbacks<typeof METHOD_NAME, EmailShortCodeProfile, UsersTable>) {
      const { authMutation } = core.bindMethod({
        name: METHOD_NAME,
        createUser,
        onSignIn,
      });

      return {
        /**
         * Send a sign-in code (valid 10 minutes) to the address. Creates
         * nothing but the challenge: no user exists for a new address until
         * the person enters the code.
         *
         * The result is the same whether or not a user has verified the
         * address. It fails only for a malformed address, or when the
         * address or the client has asked for too many emails.
         */
        sendEmailShortCode: authMutation({
          args: { email: v.string() },
          returns: sendResult,
          handler: async (ctx, { email }): Promise<SendResult> => {
            const start = await ctx.runMutation(
              component.challenge.custom.start,
              {
                // When the address has an account, the component sends the
                // code to the address as its owner verified it.
                email,
                purpose: SIGN_IN_PURPOSE,
                // Nobody is signed in: the account is found from the
                // verified address at completion.
                expectedUserId: null,
                shortCode: { origin },
                emailSender: await senderConfig(),
                ttlMs: SIGN_IN_TTL_MS,
                ...SIGN_IN_EMAIL,
              },
            );
            if (!start.success) {
              return { success: false, userError: start.userError };
            }
            return { success: true, browserSecret: start.browserSecret };
          },
        }),

        /**
         * Sign in with the code that the user typed and the secret from the
         * starting browser. The user that has verified the address signs
         * in. When no user has, the app's `createUser` creates one, and the
         * address becomes its primary email address. Everything happens in
         * one transaction.
         *
         * An incorrect code is an attempt: the email component counts it in
         * this transaction. Thus this mutation returns the failure and
         * never throws after it, because a throw rolls back the count.
         */
        signInWithEmailShortCode: authMutation({
          args: { emailCode: v.string(), browserSecret: v.string() },
          returns: signInResult,
          handler: async (
            ctx,
            { emailCode, browserSecret },
          ): Promise<SignInResult> => {
            const claim = {
              emailCode,
              browserSecret,
              purpose: SIGN_IN_PURPOSE,
            };
            // Check the code without claiming the challenge, to learn whether
            // the address has an account. The claim below runs in the same
            // transaction, so this answer still holds there.
            const verified = await ctx.runMutation(
              component.challenge.custom.verify,
              { ...claim, currentUserId: null },
            );
            if (!verified.success) {
              if (verified.userError.error === "WRONG_USER") {
                // Unexpected: the `expectedUserId` of the flow is `null`.
                throw new Error("Unexpected WRONG_USER in an email short code");
              }
              return {
                status: "error",
                userError: toShortCodeUserError(verified.userError),
              };
            }

            if (verified.emailOwnerId === null) {
              // A new address: create the user with no session, let the
              // email component record the address for it, then create the
              // session.
              const { userId } = await ctx.convexAuth.signUpWithoutSession({
                profile: {},
              });
              const recorded = await ctx.runMutation(
                component.challenge.custom
                  ._internal_dangerous_completeForNewUser,
                { ...claim, userId },
              );
              if (!recorded.success) {
                // Unexpected: `verify` passed above, in this same
                // transaction. Throw so the new user rolls back.
                throw new Error(
                  "Unexpected error when recording the email address: " +
                    recorded.userError.error,
                  { cause: recorded.userError },
                );
              }
              const tokens = await ctx.convexAuth.completeSignIn({
                userId,
                profile: {},
                authenticatedBy: component,
              });
              return { status: "complete", tokens };
            }

            const complete = await ctx.runMutation(
              component.challenge.custom.complete,
              { ...claim, currentUserId: null },
            );
            if (!complete.success || complete.emailOwnerId === null) {
              // Unexpected: `verify` passed above, in this same transaction.
              throw new Error("Unexpected error when claiming the short code");
            }
            const tokens = await ctx.convexAuth.completeSignIn({
              userId: complete.emailOwnerId,
              profile: {},
              authenticatedBy: component,
            });
            return { status: "complete", tokens };
          },
        }),
      };
    },
  };
}
