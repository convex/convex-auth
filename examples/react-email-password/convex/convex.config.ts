import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import passwordProvider from "@convex-dev/auth/components/password/convex.config.js";
import authEmail from "@convex-dev/auth/components/email/convex.config.js";
import resend from "@convex-dev/resend/convex.config.js";

const app = defineApp({
  env: {
    RESEND_API_KEY: v.string(),
    SENDER_EMAIL: v.string(),
    // Defaults in auth.ts.
    SENDER_NAME: v.optional(v.string()),
    SITE_URL: v.optional(v.string()),
  },
});

app.use(auth);
app.use(passwordProvider);
app.use(authEmail);
app.use(resend);

export default app;
