import { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";
import { components } from "./_generated/api.ts";
import type {
  FunctionArgs,
  FunctionHandle,
  FunctionReturnType,
} from "convex/server";
import type { ComponentApi as ResendApi } from "@convex-dev/resend/_generated/component.js";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { EmailSenderConfig, landingUrlProblem } from "./validation.ts";

//------------------------------------------------------------------------------

// Configuration
//------------------------------------------------------------------------------

/**
 * How long an `addEmail`, `changeEmail` or `signUp` link stays valid.
 */
export const ADD_EMAIL_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long a `custom` link stays valid when the caller gives no `ttlMs`, and
 * the bounds for the value that a caller can give.
 *
 * The `custom` kind serves many flows, thus the default is a compromise: short
 * enough for a link that can give access to an account, long enough for a
 * person who opens the mail on a second device. A flow with a stricter
 * requirement gives its own `ttlMs`. A password reset, for example, stays at
 * or below 10 minutes (OWASP ASVS v5 6.5.5).
 *
 * The maximum keeps the table from holding links for days.
 */
export const CUSTOM_TTL_DEFAULT_MS = 15 * 60 * 1000; // 15 minutes
export const CUSTOM_TTL_MIN_MS = 60 * 1000; // 1 minute
export const CUSTOM_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

// Throttle for starting challenges. Each flow sends an email, so the
// limits protect the destination mailbox from flooding and the sender's
// reputation from abuse:
// - per destination address, so an attacker cannot flood one mailbox;
// - per client IP, so one machine cannot spray many addresses.
//
// A separate limit throttles each call that tells the caller whether an
// address has an account, so that one machine cannot probe many addresses to
// find which ones have an account. `lookupEmail` and the `start` of the kinds
// that record an address (`addEmail`, `changeEmail`, `signUp`) share it. Each
// sign-in uses a lookup, thus this limit is higher than the limits for the
// challenges.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  startChallengePerEmail: { kind: "token bucket", rate: 5, period: HOUR },
  startChallengePerIp: { kind: "token bucket", rate: 20, period: HOUR },
  lookupEmailPerIp: { kind: "token bucket", rate: 60, period: HOUR },
  // Incorrect short codes, per destination address, for all of the
  // challenges of the address together. Each challenge also has its own
  // limit (`SHORT_CODE_MAX_ATTEMPTS`). This limit stays in effect if a
  // change makes the start limits higher: the number of guesses for an
  // address does not depend on the number of challenges.
  //
  // With 8 digits, 10 guesses per hour give a probability of about 0.09 %
  // per year to guess one code for one address.
  shortCodeFailurePerEmail: { kind: "token bucket", rate: 10, period: HOUR },
});

/**
 * The number of incorrect codes after which a short-code challenge is
 * deleted. The user must then start again (and get a new email).
 */
export const SHORT_CODE_MAX_ATTEMPTS = 5;

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

export async function getClientIp(ctx: MutationCtx): Promise<string> {
  const { ip } = await ctx.meta.getRequestMetadata();
  if (ip === null) {
    throw new Error(
      "The email component could not read the client IP for rate " +
        "limiting. Start challenges and look up emails from a client " +
        "request, not from a scheduled or cron function.",
    );
  }
  return ip;
}

export function emailsByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"verifiedEmails">[]> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_userId_isPrimary", (q) => q.eq("userId", userId))
    .collect();
}

/**
 * Tell whether the user has at least one verified address. Reads one row at
 * most, unlike `emailsByUserId`.
 */
export async function userHasEmail(
  ctx: QueryCtx,
  userId: string,
): Promise<boolean> {
  const first = await ctx.db
    .query("verifiedEmails")
    .withIndex("by_userId_isPrimary", (q) => q.eq("userId", userId))
    .first();
  return first !== null;
}

export function emailByNormalizedEmail(
  ctx: QueryCtx,
  normalizedEmail: string,
): Promise<Doc<"verifiedEmails"> | null> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_normalizedEmail", (q) =>
      q.eq("normalizedEmail", normalizedEmail),
    )
    .unique();
}

/** The lines of a challenge email that depend on the flow. */
export type ChallengeEmailCopy = {
  subject: string;
  // The sentence before the link, for example "Open this link to validate
  // your email address:".
  intro: string;
  // The sentence before a short code, for example "Enter this code to
  // validate your email address:". When absent, a short-code email uses
  // `intro`.
  codeIntro?: string;
};

/** The copy of the emails that record an address. */
export const VALIDATE_EMAIL_COPY: ChallengeEmailCopy = {
  subject: "Validate your email address",
  intro: "Open this link to validate your email address:",
  codeIntro: "Enter this code to validate your email address:",
};

/** "10 minutes", "1 hour", "2 hours". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The plain-text body of a challenge email. */
export function challengeEmailText(
  intro: string,
  link: string,
  ttlMs: number,
): string {
  // TODO: also offer a short code the user can type, with rate limiting on
  // attempts (a short code is guessable, unlike the 256-bit link code).
  // TODO: let the app customize this copy. A React Native app starts the
  // challenge in the app, not in a browser, so it needs a different sentence.
  return (
    `${intro}\n\n` +
    `${link}\n\n` +
    `The link stops working after ${formatDuration(ttlMs)}, and works only ` +
    "in the browser you started from.\n\n" +
    "If you did not request this email, you can safely ignore it."
  );
}

/**
 * The plain-text body of a short-code email.
 *
 * The code stands alone on its line, with no spaces or dashes in it, and
 * the sentence before it has the word "code". Mail clients that offer the
 * code for autofill (for example Apple Mail with Safari) find codes with
 * heuristics like these. The `OTP-Token` header, which
 * `sendChallengeEmail` adds, gives the code in a form that software can read.
 */
export function shortCodeEmailText(
  intro: string,
  code: string,
  ttlMs: number,
): string {
  return (
    `${intro}\n\n` +
    `${code}\n\n` +
    `The code stops working after ${formatDuration(ttlMs)}, and works only ` +
    "on the device you started from. Never give this code to another " +
    "person.\n\n" +
    "If you did not request this email, you can safely ignore it."
  );
}

/**
 * Add the code to the landing URL as the `code` query parameter.
 *
 * The URL must be absolute, because a relative URL cannot open from an email.
 * The parameter goes before the fragment, so that a landing page reads it from
 * `location.search`.
 */
export function buildLink(url: string, emailCode: string): string {
  const problem = landingUrlProblem(url);
  if (problem !== null) {
    throw new Error(
      `The email link URL ${problem}: ${url}. Give an absolute URL, for ` +
        `example "https://example.com/verify".`,
    );
  }
  const landingUrl = new URL(url);
  landingUrl.searchParams.set("code", emailCode);
  return landingUrl.toString();
}

/** The `lib.sendEmail` mutation of the `@convex-dev/resend` component. */
export type SendEmailRef = ResendApi["lib"]["sendEmail"];

/** A handle to {@link SendEmailRef}. */
export type SendEmailHandle = FunctionHandle<
  "mutation",
  FunctionArgs<SendEmailRef>,
  FunctionReturnType<SendEmailRef>
>;

export async function sendChallengeEmail(
  ctx: MutationCtx,
  sender: EmailSenderConfig,
  message: {
    to: string;
    copy: ChallengeEmailCopy;
    ttlMs: number;
  } & ({ link: string } | { shortCode: string; origin: string }),
): Promise<void> {
  const isShortCode = "shortCode" in message;
  await ctx.runMutation(sender.sendEmailHandle as SendEmailHandle, {
    options: {
      apiKey: sender.apiKey,
      // Resend's test mode only delivers to Resend's test addresses; tests
      // replace the Resend component with a stub instead.
      testMode: false,
      initialBackoffMs: sender.initialBackoffMs,
      retryAttempts: sender.retryAttempts,
    },
    from: sender.from,
    to: [message.to],
    // The code goes in the subject too, thus the user can read it in the
    // notification without opening the email.
    // The `OTP-Token` header (draft-goto-otp-token) gives the code and the
    // origin where it can be used, in a form that software can read. A
    // mail client that supports it offers the code for autofill only on
    // this origin. The origin is canonical (see `originProblem`), thus it
    // has no character that must be escaped in the quoted string.
    headers: isShortCode
      ? [
          {
            name: "OTP-Token",
            value: `"${message.shortCode}"; origin="${message.origin}"`,
          },
        ]
      : undefined,
    subject: isShortCode
      ? `${message.shortCode} is your code: ${message.copy.subject}`
      : message.copy.subject,
    text: isShortCode
      ? shortCodeEmailText(
          message.copy.codeIntro ?? message.copy.intro,
          message.shortCode,
          message.ttlMs,
        )
      : challengeEmailText(message.copy.intro, message.link, message.ttlMs),
  });
}
