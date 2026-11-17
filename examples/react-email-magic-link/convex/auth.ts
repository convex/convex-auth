import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupEmailMagicLink } from "@convex-dev/auth/methods/email-magic-link/server";

// The frontend origin the emailed links point at. Set SITE_URL on the
// deployment when the frontend does not run on the Vite default.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { sendEmailMagicLink, signInWithEmailMagicLink } =
  setupEmailMagicLink(auth, {
    component: components.authEmail,
    emailSender: {
      kind: "resend",
      sendEmail: components.resend.lib.sendEmail,
      apiKey: env.RESEND_API_KEY,
      from: `${env.SENDER_NAME ?? "My App"} <${env.SENDER_EMAIL}>`,
    },
    url: `${SITE_URL}/sign-in-with-link`,
  }).attachUserCallbacks({
    createUser: internal.users.createUser,
  });
