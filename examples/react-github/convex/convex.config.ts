import { internal } from "./_generated/api";
import { defineAuthProvider } from "@convex-dev/auth/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import github from "@convex-dev/auth/components/github/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    AUTH_GITHUB_CLIENT_ID: v.string(),
    AUTH_GITHUB_CLIENT_SECRET: v.string(),
  },
});

app.use(auth, {
  httpPrefix: "/auth",
  args: {
    providers: [
      defineAuthProvider({
        name: "github",
        profile: vGithubProfile,
        createUser: internal.users.createUser,
      }),
    ],
  },
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});

// The `httpPrefix` below controls where the component's `callback` route is
// mounted. That gets combined with the `CONVEX_SITE_URL` to form the full
// redirect URI that needs to be set on the remote identity provider config.
//
// The full redirect URI will be something like:
//
// https://happy-animal-123.convex.site/oauth/github/callback
app.use(github, {
  httpPrefix: "/oauth/github",
  env: {
    CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
  },
});

export default app;
