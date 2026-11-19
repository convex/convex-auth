import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGoogle } from "@convex-dev/auth/methods/google/server";

// The origin of the frontend, which the sign-in flow returns to. Set SITE_URL
// on the deployment when the frontend does not run on the Vite default.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(
  auth,
  {
    component: components.authGoogle,
    allowedRedirectOrigins: [SITE_URL],
  },
).attachUserCallbacks({ createUser: internal.users.createUser });
