/**
 * The live demos. Each demo is one example of `examples/`, deployed to its
 * own prod deployment in one Convex project, and served at
 * `https://<name>.demos.convex-auth.com`.
 */

/** The slug of the Convex project that holds the deployments of the demos. */
export const PROJECT_SLUG = "convex-auth-demos";

/** The parent domain of the demos. */
export const DEMOS_DOMAIN = "demos.convex-auth.com";

export type Demo = {
  /**
   * The subdomain of the demo. It is also the `reference` of the deployment
   * of the demo in the project, thus do not change it after the first deploy.
   */
  name: string;
  /**
   * The directory of the example, in `examples/`. The deploy sets `SITE_URL`
   * on the deployment to the origin of the demo, and `RP_ID` to its domain. If
   * the example checks the origin of the frontend, it must read it from
   * `SITE_URL`. A passkey example must read the domain of the passkeys from
   * `RP_ID`.
   */
  example: string;
};

export const demos: Demo[] = [
  { name: "username-password", example: "react-username-password" },
  { name: "username-passkey", example: "react-username-passkey" },
  { name: "email-password", example: "react-email-password" },
  { name: "email-magic-link", example: "react-email-magic-link" },
  { name: "google", example: "react-google" },
  { name: "apple", example: "react-apple" },
  { name: "github", example: "react-github" },
  { name: "discord", example: "react-discord" },
];

export function demoDomain(demo: Demo, parentDomain = DEMOS_DOMAIN): string {
  return `${demo.name}.${parentDomain}`;
}
