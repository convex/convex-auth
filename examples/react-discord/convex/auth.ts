import { components, internal } from "./_generated/api";
import { env } from "./_generated/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupDiscord } from "@convex-dev/auth/methods/discord/server";

// The origin of the frontend, which the sign-in flow returns to. Set SITE_URL
// on the deployment when the frontend does not run on the Vite default.
const SITE_URL = env.SITE_URL ?? "http://localhost:5173";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithDiscord, completeSignInWithDiscord } =
  setupDiscord(auth, {
    component: components.authDiscord,
    allowedRedirectOrigins: [SITE_URL],
  }).attachUserCallbacks({ createUser: internal.users.createUser });
