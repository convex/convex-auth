import { internal } from "./_generated/api";
import { defineAuthProvider } from "@convex-dev/auth/server";

import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import anonymous from "@convex-dev/auth/components/anonymous/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});

app.use(auth, {
  httpPrefix: "/auth",
  args: {
    providers: [
      defineAuthProvider({
        name: "anonymous",
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
app.use(anonymous);

export default app;
