import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/server";

// The origin of the frontend. Set SITE_URL on the deployment when the frontend
// does not run on the Vite dev server.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";
// The domain that the passkeys belong to. Set RP_ID on the deployment to the
// domain of SITE_URL, or to a parent domain of it.
const RP_ID = env.RP_ID ?? "localhost";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  startSignInWithUsernamePasskey,
  startAutofillSignInWithUsernamePasskey,
  finishSignUpWithUsernamePasskey,
  finishSignInWithUsernamePasskey,
} = setupUsernamePasskey(auth, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  rpId: RP_ID,
  origin: SITE_URL,
}).attachUserCallbacks({ createUser: internal.users.createUser });
