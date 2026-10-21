import { internal } from "./_generated/api";
import { defineAuthProvider } from "@convex-dev/auth/server";
import { vGithubProfile } from "@convex-dev/auth/methods/github/server";
import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/convex.config.js";
import anonymous from "@convex-dev/auth/components/anonymous/convex.config.js";
import github from "@convex-dev/auth/components/github/convex.config.js";
import passwordProvider from "@convex-dev/auth/components/password/convex.config.js";
import authUsername from "@convex-dev/auth/components/username/convex.config.js";

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
        name: "anonymous",
        profile: v.object({}),
        createUser: internal.users.createUser,
        onSignIn: internal.users.onSignIn,
      }),
      defineAuthProvider({
        name: "password",
        profile: v.object({}),
        createUser: internal.users.createUser,
        onSignIn: internal.users.onSignIn,
      }),
      defineAuthProvider({
        name: "github",
        profile: vGithubProfile,
        createUser: internal.users.createUser,
        onSignIn: internal.users.onSignIn,
      }),
    ],
  },
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
app.use(anonymous);
app.use(passwordProvider);
app.use(authUsername);

// The callback route is mounted at `httpPrefix` on the deployment's site URL,
// e.g. https://happy-animal-123.convex.site/oauth/github/callback. Register
// that URL as the callback on the GitHub OAuth app.
app.use(github, {
  httpPrefix: "/oauth/github",
  env: {
    CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
    CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
  },
});

export default app;
