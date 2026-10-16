import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The Apple oauth component. Install it once, with the `httpPrefix` its
 * callback is served under, and bind the four values from your Apple
 * developer account:
 *
 * ```ts
 * app.use(authApple, {
 *   httpPrefix: "/oauth/apple",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_APPLE_CLIENT_ID,
 *     TEAM_ID: app.env.AUTH_APPLE_TEAM_ID,
 *     KEY_ID: app.env.AUTH_APPLE_KEY_ID,
 *     PRIVATE_KEY: app.env.AUTH_APPLE_PRIVATE_KEY,
 *   },
 * });
 * ```
 *
 * Apple has no static client secret - instead, it takes the pieces
 * needed to sign a fresh one for every token exchange:
 *
 * - `CLIENT_ID` is the Services ID registered for your website, e.g.
 *   `com.example.app.web`.
 * - `TEAM_ID` is your 10-character Apple developer team id.
 * - `KEY_ID` is the 10-character id of the Sign in with Apple key.
 * - `PRIVATE_KEY` is the contents of that key's `AuthKey_<KEY_ID>.p8` file.
 */
const component = defineComponent("authApple", {
  env: {
    CLIENT_ID: v.string(),
    TEAM_ID: v.string(),
    KEY_ID: v.string(),
    PRIVATE_KEY: v.string(),
  },
});

export default component;
