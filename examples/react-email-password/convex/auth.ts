import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupEmailPassword } from "@convex-dev/auth/methods/email-password/server";

// The frontend origin the emailed links point at. Set SITE_URL on the
// deployment when the frontend does not run on the Vite default.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  signUpWithEmailPassword,
  completeSignUpWithEmailPassword,
  signInWithEmailPassword,
  changePassword,
  startChangeEmail,
  completeChangeEmail,
  startPasswordRecovery,
  checkPasswordRecovery,
  completePasswordRecovery,
} = setupEmailPassword(auth, {
  component: components.authEmail,
  passwordComponent: components.authPassword,
  emailSender: {
    kind: "resend",
    sendEmail: components.resend.lib.sendEmail,
    apiKey: env.RESEND_API_KEY,
    // SENDER_EMAIL must be on a domain you verified with Resend, or Resend's
    // onboarding sender (onboarding@resend.dev), which only delivers to the
    // email address of your own Resend account.
    from: `${env.SENDER_NAME ?? "My App"} <${env.SENDER_EMAIL}>`,
  },
  urls: {
    signUp: `${SITE_URL}/validate-email`,
    changeEmail: `${SITE_URL}/confirm-email-change`,
    recovery: `${SITE_URL}/reset-password`,
  },
}).attachUserCallbacks({
  createUser: internal.users.createUser,
});
