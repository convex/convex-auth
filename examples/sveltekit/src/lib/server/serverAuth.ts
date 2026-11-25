import { dev } from "$app/environment";
import { PUBLIC_CONVEX_URL } from "$env/static/public";
import { setupConvexAuthServer } from "@convex-dev/auth/ssr";
import { api } from "../../../convex/_generated/api";

// The framework-agnostic auth handlers, configured once. The `secure` cookie
// flag is decided here (HTTPS-only outside of `vite dev`) and applies to every
// handler, including sign-in. The routes under src/routes/auth/ mount what this
// returns.
export const auth = setupConvexAuthServer({
  convexUrl: PUBLIC_CONVEX_URL,
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
  cookieOptions: { secure: !dev },
});
