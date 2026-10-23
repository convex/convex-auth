import type { AuthProvider } from "convex/server";

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
 * @param options.componentName The name the app mounts the auth component
 * under in `convex.config.ts` (`app.use(auth, { name })`). Defaults to
 * `"auth"`.
 */
export function convexAuthProvider(
  options: { componentName?: string } = {},
): AuthProvider {
  const componentName = options.componentName ?? "auth";
  const cloudUrl = process.env.CONVEX_CLOUD_URL;
  if (!cloudUrl) {
    throw new Error(
      "convexAuthProvider: the CONVEX_CLOUD_URL environment variable is not set",
    );
  }
  return {
    type: "customJwt",
    // The `aud` claim that the auth component sets on the tokens.
    applicationID: "convex",
    issuer: `${cloudUrl}/components/${componentName}`,
    jwks: `${cloudUrl}/.well-known/jwks.json`,
    algorithm: "ES256",
  };
}
