import { components } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signInAnonymously } = setupAnonymous(auth, {
  component: components.authAnonymous,
});
