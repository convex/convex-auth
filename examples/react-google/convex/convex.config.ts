import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authGoogle from "@convex-dev/auth/components/google/convex.config.js";

const app = defineApp({
  env: {
    AUTH_GOOGLE_CLIENT_ID: v.string(),
    AUTH_GOOGLE_CLIENT_SECRET: v.string(),
  },
});

app.use(auth);

// The `httpPrefix` below controls where the component's `callback` route is
// mounted. That gets combined with the `CONVEX_SITE_URL` to form the full
// redirect URI that needs to be set on the remote identity provider config.
//
// The full redirect URI will be something like:
//
// https://happy-animal-123.convex.site/oauth/google/callback
app.use(authGoogle, {
  httpPrefix: "/oauth/google",
  env: {
    CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
  },
});

export default app;
