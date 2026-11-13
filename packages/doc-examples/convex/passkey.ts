import { setupPasskey } from "@convex-dev/auth/methods/passkey/server";
import { components, internal } from "./_generated/api";
import { auth } from "./auth";

// The `passkey` method, in a module of its own, thus `api.passkey` has its
// functions. The examples give `api.passkey` to its hooks.

export const {
  startSignInWithPasskey,
  finishSignInWithPasskey,
  listPasskeys,
  renamePasskey,
  startAddPasskey,
  finishAddPasskey,
  removePasskey,
  startPasskeyReauthentication,
  finishPasskeyReauthentication,
} = setupPasskey(auth, {
  component: components.authPasskey,
  rpId: "localhost",
  origin: "http://localhost:5173",
}).attachUserCallbacks({ getUserName: internal.users.passkeyUserName });
