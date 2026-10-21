import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupGoogle } from "@convex-dev/auth/methods/google/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { startSignInWithGoogle, completeSignInWithGoogle } = setupGoogle(
  auth,
  {
    component: components.authGoogle,
    allowedRedirectOrigins: ["http://localhost:5173"],
  },
);
