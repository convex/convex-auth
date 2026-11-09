import { setupConvexAuthServer } from "@convex-dev/auth/ssr";
import { api } from "@/convex/_generated/api";

// The framework-agnostic auth handlers, configured once. The `secure` cookie
// flag is decided here (HTTPS-only in production) and applies to every handler,
// including sign-in. Route files under app/auth/ mount what this returns.
export const auth = setupConvexAuthServer({
  convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  // Every function that signs a user in, meaning it creates a session and
  // returns its tokens, must be listed here. The sign-in route refuses
  // anything else.
  signIn: [
    api.auth.signInWithUsernamePassword,
    api.auth.signUpWithUsernamePassword,
    api.auth.completeSignInWithGithub,
  ],
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
});
