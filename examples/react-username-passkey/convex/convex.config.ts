import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authPasskey from "@convex-dev/auth/components/passkey/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";

const app = defineApp({
  env: {
    // Defaults in auth.ts.
    SITE_URL: v.optional(v.string()),
    RP_ID: v.optional(v.string()),
  },
});

app.use(auth);
app.use(authPasskey);
app.use(authUsername);

export default app;
