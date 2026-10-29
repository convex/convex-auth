import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";
import { setupGithub } from "@convex-dev/auth/methods/github/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";

// The core owns sessions, accounts, and JWT minting. Each sign-in method is
// wired to it with its own setup function, and only hands back its functions
// once the app attaches the callbacks that create its user rows. Each method
// exposes the functions its client hooks call: `signInAnonymously` for the
// anonymous method, `signUpWithUsernamePassword` / `signInWithUsernamePassword`
// for the password one.
// Under SSR those calls get proxied to Convex via the SSR host. The sign-in
// functions exposed here are wired up to be proxied in src/lib/serverAuth.ts.
const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

// `onSignIn` is optional, and runs on every sign-in including the first. This
// app uses it to stamp the user's last sign-in.
export const { signInAnonymously } = setupAnonymous(auth, {
  component: components.authAnonymous,
}).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});

export const { signUpWithUsernamePassword, signInWithUsernamePassword } =
  setupUsernamePassword(auth, {
    component: components.authPassword,
    usernameComponent: components.authUsername,
  }).attachUserCallbacks({
    createUser: internal.users.createUser,
    onSignIn: internal.users.onSignIn,
  });

export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(
  auth,
  {
    component: components.authGithub,
    allowedRedirectOrigins: ["http://localhost:3000"],
  },
).attachUserCallbacks({
  createUser: internal.users.createUser,
  onSignIn: internal.users.onSignIn,
});
