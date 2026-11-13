/**
 * The email sender options that the methods which send email share, and the
 * values that they derive from them.
 *
 * @module
 */
import { createFunctionHandle } from "convex/server";
import type { SendEmailRef } from "../components/email/helpers.ts";
import type { EmailSenderConfig } from "../components/email/validation.ts";

/**
 * How a method sends emails: challenge emails (through the email component)
 * and, for some methods, security notifications (directly).
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component. Mount that component in the app and pass its `sendEmail`
 * reference and your Resend API key here.
 *
 * TODO: support other email providers.
 * TODO: offer a first-party zero-configuration email service.
 * TODO: let applications customize the email templates.
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

/** The Resend runtime options `lib.sendEmail` requires. */
export function senderRuntimeOptions(emailSender: EmailSenderOptions) {
  return {
    apiKey: emailSender.apiKey,
    // TODO: make these values configurable.
    initialBackoffMs: 30 * 1000,
    retryAttempts: 5,
  };
}

/**
 * The sender config the email component's `start` mutations accept.
 *
 * It is asynchronous because `createFunctionHandle` is, and it works only
 * while a Convex function runs, not when `convex/auth.ts` is imported and a
 * method's setup runs.
 */
export async function senderConfig(
  emailSender: EmailSenderOptions,
): Promise<EmailSenderConfig> {
  return {
    kind: "resend",
    sendEmailHandle: await createFunctionHandle(emailSender.sendEmail),
    from: emailSender.from,
    ...senderRuntimeOptions(emailSender),
  };
}
