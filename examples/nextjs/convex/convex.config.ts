import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import authAnonymous from "@convex-dev/auth/components/anonymous/convex.config.js";
import authGithub from "@convex-dev/auth/components/github/convex.config.js";
import authPassword from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";

const app = defineApp({
  env: {
    AUTH_GITHUB_CLIENT_ID: v.string(),
    AUTH_GITHUB_CLIENT_SECRET: v.string(),
  },
});

app.use(auth);
app.use(authAnonymous);
app.use(authPassword);
app.use(authUsername);

// The callback route is mounted at `httpPrefix` on the deployment's site URL,
// e.g. https://happy-animal-123.convex.site/oauth/github/callback. Register
// that URL as the callback on the GitHub OAuth app.
app.use(authGithub, {
  httpPrefix: "/oauth/github",
  env: {
    CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
  },
});

export default app;
