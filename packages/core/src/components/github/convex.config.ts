import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The GitHub oauth component. Install it once, with the `httpPrefix` its
 * callback is served under, and bind the OAuth app's credentials:
 *
 * ```ts
 * app.use(authGithub, {
 *   httpPrefix: "/oauth/github",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
 *   },
 * });
 * ```
 */
const component = defineComponent("authGithub", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
