/**
 * The generic oauth component.
 *
 * @internal Not public until the API for custom OAuth providers is stable.
 * @module
 */
import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The configurable generic oauth component, for identity providers without a
 * built-in component. Its env sets the provider: the token endpoint, the
 * issuers of the id_tokens, the userinfo endpoints, and the field that has
 * the account id. The app's `setupOauth` catalog sets the authorization
 * endpoint, the scopes, and the profile mapping.
 *
 * Install it once per identity provider, each with its own name and
 * `httpPrefix`. The callback is served at `<httpPrefix>/callback`.
 *
 * ```ts skip-check
 * app.use(authOauth, {
 *   name: "authAcme",
 *   httpPrefix: "/oauth/acme",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_ACME_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_ACME_CLIENT_SECRET,
 *     TOKEN_ENDPOINT: "https://acme.example.com/oauth/token",
 *     ISSUERS: "https://acme.example.com",
 *   },
 * });
 * ```
 *
 * - `TOKEN_ENDPOINT`: the token endpoint of the provider (an https URL).
 * - `ISSUERS`: for an OIDC provider, the accepted `iss` values of its
 *   id_tokens, separated by commas. All values must name the same issuing
 *   authority, with the same `sub` for an account.
 * - `USERINFO_ENDPOINTS`: for a provider whose identity comes from userinfo,
 *   a JSON object of the endpoints to fetch with the access token, keyed by
 *   the name that the profile mapping reads each response under, for example
 *   `{"user":"https://api.acme.example.com/user"}`.
 * - `ACCOUNT_ID_FIELD`: where the account id is. `sub` (the default) is the
 *   `sub` claim of the id_token. `<endpoint>.<field>` is a field of a
 *   userinfo response, for example `user.id`.
 *
 * Set at least one of `ISSUERS` and `USERINFO_ENDPOINTS`.
 *
 * The provider has to authenticate with a static client secret. A provider
 * that wants a signed short-lived secret needs a component of its own.
 */
const component = defineComponent("authOauth", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
    TOKEN_ENDPOINT: v.string(),
    ISSUERS: v.optional(v.string()),
    USERINFO_ENDPOINTS: v.optional(v.string()),
    ACCOUNT_ID_FIELD: v.optional(v.string()),
  },
});

export default component;
