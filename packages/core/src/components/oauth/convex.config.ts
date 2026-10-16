import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The configurable generic oauth component, for identity providers without a
 * built-in component. It takes the endpoints, scopes, and profile mapping from
 * the app's `setupOauth` catalog.
 *
 * Install it once per identity provider, each with its own name and
 * `httpPrefix`. The callback is served at `<httpPrefix>/callback`.
 *
 * ```ts
 * app.use(authOauth, {
 *   name: "authAcme",
 *   httpPrefix: "/oauth/acme",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_ACME_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_ACME_CLIENT_SECRET,
 *   },
 * });
 * ```
 *
 * The provider has to authenticate with a static client secret. A provider
 * that wants a signed short-lived secret needs a component of its own.
 */
const component = defineComponent("authOauth", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
