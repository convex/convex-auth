import { internal } from "./_generated/api";
import { defineAuthProvider } from "@convex-dev/auth/server";

import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import passwordProvider from "@convex-dev/auth/components/password/convex.config.js";
import authEmail from "@convex-dev/auth/components/email/convex.config.js";
import resend from "@convex-dev/resend/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    RESEND_API_KEY: v.string(),
    SENDER_EMAIL: v.string(),
    // Defaults in auth.ts.
    SENDER_NAME: v.optional(v.string()),
    SITE_URL: v.optional(v.string()),
  },
});

app.use(auth, {
  httpPrefix: "/auth",
  args: {
    providers: [
      defineAuthProvider({
        name: "emailPassword",
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
app.use(passwordProvider);
app.use(authEmail);
app.use(resend);

export default app;
