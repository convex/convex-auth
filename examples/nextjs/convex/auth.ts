import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";

// Callbacks are registered in convex.config.ts; these are the public endpoints.
const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signInAnonymously } = setupAnonymous(auth, {
  component: components.authAnonymous,
});

export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
  setupUsernamePassword(auth, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  });

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  auth,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:3000"],
  },
);
