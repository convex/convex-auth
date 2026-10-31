import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { setupConvexAuth } from "@convex-dev/auth/server";
import { setupWorkos } from "@convex-dev/auth/methods/workos/server";
import { deprovision } from "./users";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

const workos = setupWorkos(auth, {
  component: components.authWorkos,
  module: "auth",
  allowedRedirectOrigins: ["http://localhost:5173"],
});

export const { startSignInWithWorkos, completeSignInWithWorkos } =
  workos.attachUserCallbacks({
    createUser: internal.users.createUser,
    onSignIn: internal.users.onSignIn,
  });

/**
 * Map the directory onto the app's users. This example only acts on
 * deprovisioning: it marks the user and revokes every one of their sessions,
 * so they are signed out everywhere within seconds of the directory's change.
 */
export const { syncWorkos, unregisterWorkos, onWorkosEvent } =
  workos.attachDirectoryCallbacks<DataModel>({
    "dsync.user.updated": async (ctx, user) => {
      if (user.state !== "active") await deprovision(ctx, user);
    },
    "dsync.user.deleted": async (ctx, user) => {
      await deprovision(ctx, user);
    },
  });
