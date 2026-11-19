/**
 * The `emailMagicLink` method: a person signs in with a link that they
 * receive by email. There is no password, and one form serves both sign-up
 * and sign-in.
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
  completeChallengeUserError,
  landingUrlProblem,
  type EmailSenderConfig,
} from "../../components/email/validation.ts";
import type { SendEmailRef } from "../../components/email/helpers.ts";

/** The name of this sign-in method. The app's user callbacks get it as `method.name`. */
const METHOD_NAME = "emailMagicLink";

/**
 * The purpose of the `custom` challenge that a sign-in starts. The name
 * carries a prefix so that an application's own custom purposes cannot
 * collide with it.
 */
const SIGN_IN_PURPOSE = "convexAuth/emailMagicLink/signIn";

/**
 * How long a sign-in link stays valid. OWASP ASVS v5 6.5.5 requires at most
 * 10 minutes for an out-of-band authentication request.
 */
const SIGN_IN_TTL_MS = 10 * 60 * 1000;

// TODO: let applications customize this copy.
const SIGN_IN_EMAIL = {
  subject: "Your sign-in link",
  intro: "Open this link to sign in:",
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
 * Options for {@link setupEmailMagicLink}.
 */
export type EmailMagicLinkOptions = {
  /**
   * The mounted email component (`components.authEmail`). The method uses it
   * to track verified emails and to run the challenges.
   */
  component: ComponentApi;
  /** How the method sends emails. */
  emailSender: EmailSenderOptions;
  /**
   * The landing page that the emailed link points at. The link's `code`
   * query parameter will be appended to this URL.
   */
  url: string;
};

const sendResult = v.union(
  v.object({ success: v.literal(true), browserSecret: v.string() }),
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);

/**
 * The result of `sendEmailMagicLink`. On success, the secret the browser
 * must keep for `signInWithEmailMagicLink`. The result does not tell whether
 * the address has an account.
 */
export type SendResult = Infer<typeof sendResult>;

const signInResult = v.union(
  vSignInComplete,
  vSignInError(completeChallengeUserError),
);

/** The result of `signInWithEmailMagicLink`: the minted session tokens, or an error. */
export type SignInResult = Infer<typeof signInResult>;

export type EmailMagicLinkProfile = Record<string, never>;

/**
 * A sign-in method where a person signs in with a link received by email.
 * One form serves both a person who has an account and a person who has
 * none. Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * import { components, internal } from "./_generated/api";
 * import { env } from "./_generated/server";
 * import { setupConvexAuth } from "@convex-dev/auth/server";
 * import { setupEmailMagicLink } from "@convex-dev/auth/methods/email-magic-link/server";
 *
 * // The frontend origin the emailed links point at.
 * const SITE_URL = env.SITE_URL ?? "http://localhost:5173";
 *
 * const auth = setupConvexAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { sendEmailMagicLink, signInWithEmailMagicLink } =
 *   setupEmailMagicLink(auth, {
 *     component: components.authEmail,
 *     emailSender: {
 *       kind: "resend",
 *       sendEmail: components.resend.lib.sendEmail,
 *       apiKey: env.RESEND_API_KEY,
 *       from: "My App <auth@example.com>",
 *     },
 *     url: `${SITE_URL}/sign-in-with-link`,
 *   }).attachUserCallbacks({
 *     createUser: internal.users.createUserEmailMagicLink,
 *   });
 * ```
 *
 * - `sendEmailMagicLink` sends the link. It creates no user, and it gives
 *   the same result whether the address has an account or not.
 * - `signInWithEmailMagicLink` signs in the user that has verified the
 *   address. When no user has, it creates one with the app's `createUser`,
 *   and records the address as its primary email address.
 * - A link works once, for 10 minutes, and only in the browser that asked
 *   for it. Opening the link does not use it: the browser must also send
 *   its secret. Thus a mail scanner that opens the link cannot use it or
 *   make it fail.
 */
export function setupEmailMagicLink<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: EmailMagicLinkOptions,
) {
  const { component, emailSender, url } = options;
  // Validate the URL now, so a mistake fails at deploy time rather than in
  // the first email.
  const problem = landingUrlProblem(url);
  if (problem !== null) {
    throw new Error(
      `setupEmailMagicLink: url ${problem}: ${url}. Give an absolute URL, ` +
        `for example "https://example.com/sign-in-with-link".`,
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
    }: UserCallbacks<typeof METHOD_NAME, EmailMagicLinkProfile, UsersTable>) {
      const { authMutation } = core.bindMethod({
        name: METHOD_NAME,
        createUser,
        onSignIn,
      });

      return {
        /**
         * Send a sign-in link (valid 10 minutes) to the address. Creates
         * nothing but the challenge: no user exists for a new address until
         * the person opens the link.
         *
         * The result is the same whether or not a user has verified the
         * address. It fails only for a malformed address, or when the
         * address or the client has asked for too many emails.
         */
        sendEmailMagicLink: authMutation({
          args: { email: v.string() },
          returns: sendResult,
          handler: async (ctx, { email }): Promise<SendResult> => {
            const start = await ctx.runMutation(
              component.challenge.custom.start,
              {
                // When the address has an account, the component sends the
                // link to the address as its owner verified it.
                email,
                purpose: SIGN_IN_PURPOSE,
                // Nobody is signed in: the account is found from the
                // verified address at completion.
                expectedUserId: null,
                url,
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
         * Sign in with the code from the link and the secret from the
         * starting browser. The user that has verified the address signs
         * in. When no user has, the app's `createUser` creates one, and the
         * address becomes its primary email address. Everything happens in
         * one transaction.
         */
        signInWithEmailMagicLink: authMutation({
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
            // Look at the challenge without claiming it, to learn whether
            // the address has an account. The claim below runs in the same
            // transaction, so this answer still holds there.
            const peek = await ctx.runQuery(component.challenge.custom.peek, {
              ...claim,
              currentUserId: null,
            });
            if (!peek.success) {
              if (peek.userError.error === "WRONG_USER") {
                // Unexpected: the `expectedUserId` of the flow is `null`.
                throw new Error("Unexpected WRONG_USER in a magic link");
              }
              return { status: "error", userError: peek.userError };
            }

            if (peek.emailOwnerId === null) {
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
                // Unexpected: `peek` passed above, in this same transaction.
                // Throw so the new user rolls back.
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
              // Unexpected: `peek` passed above, in this same transaction.
              throw new Error("Unexpected error when claiming the magic link");
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
