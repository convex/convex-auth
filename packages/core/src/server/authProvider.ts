import type { AuthProvider } from "convex/server";
import { CORE_COMPONENT_PATH } from "../lib/coreComponent.ts";

/**
 * The provider that the app lists in `convex/auth.config.ts` to accept the
 * access tokens of Convex Auth.
 *
 * Access tokens are signed with the deployment's key: the auth component
 * mints them via `ctx.auth.signJwt`, so their issuer is the component's path
 * under the deployment, and the public keys are the deployment's JWKS.
 *
 * ```ts
 * // convex/auth.config.ts
 * import type { AuthConfig } from "convex/server";
 * import { convexAuthProvider } from "@convex-dev/auth/server";
 *
 * export default {
 *   providers: [convexAuthProvider()],
 * } satisfies AuthConfig;
 * ```
 *
 * The app must mount the auth component as `auth` (`app.use(auth)` in
 * `convex.config.ts`), which is the default name.
 */
export function convexAuthProvider(): AuthProvider {
  const cloudUrl = process.env.CONVEX_CLOUD_URL;
  if (!cloudUrl) {
    throw new Error(
      "convexAuthProvider: the CONVEX_CLOUD_URL environment variable is not set",
    );
  }
  return {
    type: "customJwt",
    // The `aud` claim that the auth component sets on the tokens.
    applicationID: "convex-auth",
    issuer: `${cloudUrl}/components/${CORE_COMPONENT_PATH}`,
    jwks: `${cloudUrl}/.well-known/jwks.json`,
    algorithm: "ES256",
  };
}
