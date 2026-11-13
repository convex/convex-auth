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

/**
 * The length of a sign-in code when the app gives none, and the bounds for
 * the value that an app can give.
 *
 * The start limits below allow 5 challenges for one address at once, then 1
 * every 12 minutes, and each challenge accepts `CODE_ATTEMPTS` wrong codes.
 * Thus a person who tries to guess the code of one address gets 50 tries in
 * the first hour, then 25 an hour. With 8 digits, the chance that one of them
 * is right is 1 in 2 million in the first hour, 1 in 4 million each hour
 * after, and about 1 in 450 after a year of tries. With 6 digits, it is 1 in
 * 20,000 in the first hour, 1 in 40,000 each hour after, and about 1 in 5
 * after a year. Each challenge also sends an email to the address, thus its
 * owner sees the tries.
 */
export const SIGN_IN_CODE_LENGTH_DEFAULT = 8;
export const SIGN_IN_CODE_LENGTH_MIN = 6;
export const SIGN_IN_CODE_LENGTH_MAX = 10;

/**
 * How many wrong codes a challenge with a short code accepts. The wrong code
 * that uses the last attempt deletes the challenge.
 */
export const CODE_ATTEMPTS = 5;

/**
 * How long a sign-in code stays valid when the app gives no `ttlMs`, and the
 * bounds for the value that an app can give. A person types the code soon
 * after it arrives. The default leaves time for a slow mail server.
 */
export const SIGN_IN_TTL_DEFAULT_MS = 10 * 60 * 1000; // 10 minutes
export const SIGN_IN_TTL_MIN_MS = 60 * 1000; // 1 minute
export const SIGN_IN_TTL_MAX_MS = 30 * 60 * 1000; // 30 minutes

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
});

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
    .withIndex("by_userId", (q) => q.eq("userId", userId))
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
    .withIndex("by_userId", (q) => q.eq("userId", userId))
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
};

/** The copy of the emails that record an address. */
export const VALIDATE_EMAIL_COPY: ChallengeEmailCopy = {
  subject: "Validate your email address",
  intro: "Open this link to validate your email address:",
};

/**
 * The copy of the sign-in code email. `{code}` in the subject is replaced by
 * the code, thus a phone can show the code in the notification of the email.
 */
export const SIGN_IN_COPY: ChallengeEmailCopy = {
  subject: "{code} is your sign-in code",
  intro: "Enter this code to sign in:",
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
 * The plain-text body of a sign-in code email. The code is alone on its line,
 * so that it is easy to copy, and so that a mail app can offer to fill it in.
 */
export function codeEmailText(
  intro: string,
  code: string,
  ttlMs: number,
): string {
  return (
    `${intro}\n\n` +
    `${code}\n\n` +
    `The code stops working after ${formatDuration(ttlMs)}, and works only ` +
    "in the app or browser where you asked for it. Do not share it with " +
    "anyone.\n\n" +
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
    link: string;
    ttlMs: number;
  },
): Promise<void> {
  await sendEmail(ctx, sender, {
    to: message.to,
    subject: message.copy.subject,
    text: challengeEmailText(message.copy.intro, message.link, message.ttlMs),
  });
}

/**
 * Send the email of a challenge that carries a short code. `{code}` in the
 * subject of `copy` is replaced by the code.
 */
export async function sendCodeEmail(
  ctx: MutationCtx,
  sender: EmailSenderConfig,
  message: {
    to: string;
    copy: ChallengeEmailCopy;
    code: string;
    ttlMs: number;
  },
): Promise<void> {
  await sendEmail(ctx, sender, {
    to: message.to,
    subject: message.copy.subject.split("{code}").join(message.code),
    text: codeEmailText(message.copy.intro, message.code, message.ttlMs),
  });
}

async function sendEmail(
  ctx: MutationCtx,
  sender: EmailSenderConfig,
  message: { to: string; subject: string; text: string },
): Promise<void> {
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
    subject: message.subject,
    text: message.text,
  });
}
