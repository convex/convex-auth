import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The Discord oauth component. Install it once, with the `httpPrefix` its
 * callback is served under, and bind the OAuth app's credentials:
 *
 * ```ts
 * app.use(authDiscord, {
 *   httpPrefix: "/oauth/discord",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_DISCORD_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_DISCORD_CLIENT_SECRET,
 *   },
 * });
 * ```
 */
const component = defineComponent("authDiscord", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
