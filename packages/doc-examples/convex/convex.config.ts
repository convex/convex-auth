import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authAnonymous from "@convex-dev/auth/components/anonymous/convex.config.js";
import authApple from "@convex-dev/auth/components/apple/convex.config.js";
import authEmail from "@convex-dev/auth/components/email/convex.config.js";
import authGithub from "@convex-dev/auth/components/github/convex.config.js";
import authGoogle from "@convex-dev/auth/components/google/convex.config.js";
import authOauth from "@convex-dev/auth/components/oauth/convex.config.js";
import authPasskey from "@convex-dev/auth/components/passkey/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";
import resend from "@convex-dev/resend/convex.config.js";

const app = defineApp({
  env: {
    AUTH_GOOGLE_CLIENT_ID: v.string(),
    AUTH_GOOGLE_CLIENT_SECRET: v.string(),
    AUTH_APPLE_CLIENT_ID: v.string(),
    AUTH_APPLE_TEAM_ID: v.string(),
    AUTH_APPLE_KEY_ID: v.string(),
    AUTH_APPLE_PRIVATE_KEY: v.string(),
    AUTH_GITHUB_CLIENT_ID: v.string(),
    AUTH_GITHUB_CLIENT_SECRET: v.string(),
    AUTH_ACME_CLIENT_ID: v.string(),
    AUTH_ACME_CLIENT_SECRET: v.string(),
    RESEND_API_KEY: v.string(),
    SITE_URL: v.string(),
  },
});

app.use(auth);
// A second core, for the examples that mount it under another name.
app.use(auth, { name: "myAuth" });
app.use(authAnonymous);
app.use(authPassword);
app.use(authUsername);
app.use(authEmail);
app.use(authPasskey);
app.use(authGoogle, {
  httpPrefix: "/oauth/google",
  env: {
    CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
  },
});
app.use(authApple, {
  httpPrefix: "/oauth/apple",
  env: {
    CLIENT_ID: app.env.AUTH_APPLE_CLIENT_ID,
    TEAM_ID: app.env.AUTH_APPLE_TEAM_ID,
    KEY_ID: app.env.AUTH_APPLE_KEY_ID,
    PRIVATE_KEY: app.env.AUTH_APPLE_PRIVATE_KEY,
  },
});
app.use(authGithub, {
  httpPrefix: "/oauth/github",
  env: {
    CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
  },
});
app.use(authOauth, {
  name: "authAcme",
  httpPrefix: "/oauth/acme",
  env: {
    CLIENT_ID: app.env.AUTH_ACME_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_ACME_CLIENT_SECRET,
  },
});
app.use(resend);

export default app;
