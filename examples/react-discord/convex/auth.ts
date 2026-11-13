import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupDiscord } from "@convex-dev/auth/methods/discord/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithDiscord, completeSignInWithDiscord } =
  setupDiscord(auth, {
    component: components.authDiscord,
    allowedRedirectOrigins: ["http://localhost:5173"],
  }).attachUserCallbacks({ createUser: internal.users.createUser });
