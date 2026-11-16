import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupEmailCode } from "@convex-dev/auth/methods/email-code/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithEmailCode, completeSignInWithEmailCode } =
  setupEmailCode(auth, {
    component: components.authEmail,
    emailSender: {
      kind: "resend",
      sendEmail: components.resend.lib.sendEmail,
      apiKey: env.RESEND_API_KEY,
      // SENDER_EMAIL must be on a domain you verified with Resend, or
      // Resend's onboarding sender (onboarding@resend.dev), which only
      // delivers to the email address of your own Resend account.
      from: `${env.SENDER_NAME ?? "My App"} <${env.SENDER_EMAIL}>`,
    },
  }).attachUserCallbacks({
    createUser: internal.users.createUser,
  });
