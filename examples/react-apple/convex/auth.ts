import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupApple } from "@convex-dev/auth/methods/apple/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithApple, completeSignInWithApple } = setupApple(
  auth,
  {
    component: components.authApple,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
);
