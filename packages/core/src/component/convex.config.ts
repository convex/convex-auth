import { defineComponent } from "convex/server";

/**
 * The core auth component.
 *
 * Owns:
 *  - the provider-account <-> app-user mapping (`accounts`)
 *  - session lifetimes (`sessions`: refresh tokens, rotation, expiry)
 *
 * Access tokens are signed with the deployment's own key
 * (`ctx.auth.signJwt`), so the component carries no signing material of its
 * own. The public keys live at
 * `${CONVEX_CLOUD_URL}/.well-known/jwks.json`, and tokens minted here carry
 * `iss = ${CONVEX_CLOUD_URL}/components/auth`.
 *
 * It does NOT know about any specific provider. Providers hand it identity
 * claims (see ../lib/types) and the core turns that into a session + JWT.
 *
 * Apps install it from `@convex-dev/auth/convex.config.js`.
 */
const component = defineComponent("auth");

export default component;
