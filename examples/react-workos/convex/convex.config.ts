import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import workos from "@convex-dev/auth/components/workos/convex.config.js";

const app = defineApp({
  env: {
    AUTH_WORKOS_CLIENT_ID: v.string(),
    AUTH_WORKOS_API_KEY: v.string(),
  },
});

app.use(auth);

// The `httpPrefix` below controls where the component's routes are mounted:
// the SSO callback at `<site-url>/workos/callback`, which is the redirect URI
// to add in the WorkOS dashboard, and the webhook at
// `<site-url>/workos/webhook`, which `syncWorkos` registers at WorkOS.
app.use(workos, {
  httpPrefix: "/workos",
  env: {
    CLIENT_ID: app.env.AUTH_WORKOS_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_WORKOS_API_KEY,
  },
});

export default app;
