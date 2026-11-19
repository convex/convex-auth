import { components, internal } from "./_generated/api";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupUsernamePasskey } from "@convex-dev/auth/methods/username-passkey/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const {
  startSignInWithUsernamePasskey,
  startAutofillSignInWithUsernamePasskey,
  finishSignUpWithUsernamePasskey,
  finishSignInWithUsernamePasskey,

  listPasskeys,
  renamePasskey,

  startAddPasskey,
  verifyAddPasskey,
  finishAddPasskey,

  startRemovePasskey,
  finishRemovePasskey,
} = setupUsernamePasskey(auth, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  // The relying party ID and the origin of the Vite dev server. A deployed
  // app uses its own domain here.
  rpId: "localhost",
  origin: "http://localhost:5173",
}).attachUserCallbacks({ createUser: internal.users.createUser });
