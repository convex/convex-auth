import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  auth,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
);
