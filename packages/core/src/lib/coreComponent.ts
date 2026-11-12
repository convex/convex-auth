/**
 * The path of the core component. The app must mount the core as `auth`:
 *
 * ```ts
 * // convex/convex.config.ts
 * import { defineApp } from "convex/server";
 * import auth from "@convex-dev/auth/convex.config.js";
 *
 * const app = defineApp();
 * app.use(auth);
 * export default app;
 * ```
 *
 * The other components accept the attestations of the core only from this
 * path, and the app's auth.config.ts accepts the access tokens of the core
 * only from this path.
 *
 * @module
 */
export const CORE_COMPONENT_PATH = "auth";

/**
 * Throw when the issuer of a token that the core signed shows that the app
 * mounted the core at a path that is not {@link CORE_COMPONENT_PATH}.
 *
 * The core calls this function each time it signs an access token, thus a wrong mount
 * fails at the first sign-in with a clear message, and not with an invalid
 * attestation in a different component.
 *
 * A token that the deployment signed as the app (no component path) passes.
 * That only occurs in tests, which run the core as the app.
 */
export function assertMountedAsCore(token: string): void {
  const componentPath = componentPathFromIssuer(issuerOf(token));
  if (componentPath !== null && componentPath !== CORE_COMPONENT_PATH) {
    throw new Error(
      `The auth component is mounted at "${componentPath}", but it must be ` +
        `mounted at "${CORE_COMPONENT_PATH}". Use \`app.use(auth)\` in ` +
        `convex.config.ts, without a \`name\` option.`,
    );
  }
}

/**
 * Get the component path from the issuer of a deployment JWT, for example
 * `"authPassword"` from `https://x.convex.cloud/components/authPassword`.
 *
 * Returns `null` when the issuer is not a component of this deployment, for
 * example the deployment itself (a token that the app signed).
 */
export function componentPathFromIssuer(issuer: unknown): string | null {
  if (typeof issuer !== "string") return null;
  const prefix = `${cloudUrl()}/components/`;
  if (!issuer.startsWith(prefix)) return null;
  const path = issuer.slice(prefix.length);
  return path === "" ? null : path;
}

function cloudUrl(): string {
  const url = process.env.CONVEX_CLOUD_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "The CONVEX_CLOUD_URL environment variable is not set. Convex Auth needs it to check the issuer of a token.",
    );
  }
  return url.replace(/\/+$/, "");
}

/** Read the `iss` claim of a JWT without a check of its signature. */
function issuerOf(token: string): unknown {
  const payload = token.split(".")[1] ?? "";
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  return (
    JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as {
      iss?: unknown;
    }
  ).iss;
}
