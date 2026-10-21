import { setupConvexAuthServer } from "@convex-dev/auth/ssr";
import { api } from "./convex/_generated/api";

// The SSR setup of a Next.js app. The SSR examples import it from `@/auth`.
export const auth = setupConvexAuthServer({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  signIn: [api.auth.signInAnonymously, api.auth.signInWithUsernamePassword],
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
});
