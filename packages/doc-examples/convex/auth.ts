import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupApple } from "@convex-dev/auth/methods/apple/server";
import { setupDiscord } from "@convex-dev/auth/methods/discord/server";
import { setupEmailPassword } from "@convex-dev/auth/methods/email-password/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";
import { setupGoogle } from "@convex-dev/auth/methods/google/server";
import { setupUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";
import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";

// Every sign-in method, thus `api.auth` has the functions of each one. The
// examples give `api.auth` to the hooks of the methods.

const allowedRedirectOrigins = ["http://localhost:5173"];

// `setupEmailPassword` checks its URLs when the module loads, and no deployment
// sets SITE_URL for this app (codegen pushes it to a deployment with no
// environment variables).
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  signUpWithUsernamePassword,
  signInWithUsernamePassword,
  changePassword,
} = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUserPassword });

// The email + password method has a `changePassword` too.
export const {
  signUpWithEmailPassword,
  completeSignUpWithEmailPassword,
  signInWithEmailPassword,
  changePassword: changeEmailPassword,
  startPasswordRecovery,
  checkPasswordRecovery,
  completePasswordRecovery,
  startChangeEmail,
  completeChangeEmail,
} = setupEmailPassword(auth, {
  component: components.authEmail,
  passwordComponent: components.authPassword,
  emailSender: {
    kind: "resend",
    sendEmail: components.resend.lib.sendEmail,
    apiKey: env.RESEND_API_KEY,
    from: "My App <auth@example.com>",
  },
  urls: {
    signUp: `${SITE_URL}/validate-email`,
    changeEmail: `${SITE_URL}/confirm-email-change`,
    recovery: `${SITE_URL}/reset-password`,
  },
}).attachUserCallbacks({ createUser: internal.users.createUserEmailPassword });

export const {
  startSignInWithUsernamePasskey,
  startAutofillSignInWithUsernamePasskey,
  finishSignUpWithUsernamePasskey,
  finishSignInWithUsernamePasskey,
  listPasskeys,
  renamePasskey,
  startAddPasskey,
  verifyAddPasskey,
  finishAddPasskey,
  startRemovePasskey,
  finishRemovePasskey,
} = setupUsernamePasskey(auth, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  rpId: "localhost",
  origin: "http://localhost:5173",
}).attachUserCallbacks({ createUser: internal.users.createUserPasskey });

export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(
  auth,
  { component: components.authGoogle, allowedRedirectOrigins },
).attachUserCallbacks({ createUser: internal.users.createUserGoogle });

export const { startSignInWithApple, completeSignInWithApple } = setupApple(
  auth,
  { component: components.authApple, allowedRedirectOrigins },
).attachUserCallbacks({ createUser: internal.users.createUserApple });

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  auth,
  { component: components.authGithub, allowedRedirectOrigins },
).attachUserCallbacks({ createUser: internal.users.createUserGithub });

export const { startSignInWithDiscord, completeSignInWithDiscord } =
  setupDiscord(auth, {
    component: components.authDiscord,
    allowedRedirectOrigins,
  }).attachUserCallbacks({ createUser: internal.users.createUserDiscord });
