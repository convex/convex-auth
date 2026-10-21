import { internal } from "./_generated/api";
import { defineAuthProvider } from "@convex-dev/auth/server";

import { defineApp } from "convex/server";
import { v } from "convex/values";
import core from "@convex-dev/auth/convex.config.js";
import passkey from "@convex-dev/auth/components/passkey/convex.config.js";
import username from "@convex-dev/auth/components/username/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});

app.use(core, {
  httpPrefix: "/auth",
  args: {
    providers: [
      defineAuthProvider({
        name: "passkey",
        profile: v.object({}),
        createUser: internal.users.createUser,
      }),
    ],
  },
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
app.use(passkey);
app.use(username);

export default app;
