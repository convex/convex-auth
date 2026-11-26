/**
 * Finds the deployment of an app: its URL and the key for the data sync.
 * Pure functions; `cli.ts` reads the files.
 *
 * @module
 */

/** The variables that hold the deployment URL, for the frameworks we know. */
export const URL_VARIABLES = [
  "VITE_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_URL",
  "EXPO_PUBLIC_CONVEX_URL",
  "PUBLIC_CONVEX_URL",
  "CONVEX_URL",
] as const;

/** The variables of a `.env` file. */
export function parseEnvFile(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (match === null) {
      continue;
    }
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    variables[match[1]] = value;
  }
  return variables;
}

/** The deployment URL from the variables of the app, or null. */
export function deploymentUrlOf(
  variables: Record<string, string | undefined>,
): string | null {
  for (const name of URL_VARIABLES) {
    const value = variables[name];
    if (value !== undefined && value !== "") {
      return value.replace(/\/+$/, "");
    }
  }
  return null;
}

/**
 * Whether `CONVEX_DEPLOYMENT` names a deployment on this machine, whose admin
 * key is in `.convex/local/default/config.json`.
 */
export function isLocalDeployment(deployment: string | undefined): boolean {
  return (
    deployment !== undefined &&
    (deployment.startsWith("anonymous:") || deployment.startsWith("local:"))
  );
}

/**
 * The name of the deployment that a deploy key is for (`dev:happy-cat-123|…`
 * gives `happy-cat-123`), or null for a key of another shape.
 */
export function deploymentNameOfKey(key: string): string | null {
  const match = /^(?:dev|prod|preview):([^|]+)\|/.exec(key);
  return match === null ? null : match[1];
}

/**
 * A warning when a deploy key is for another deployment than the URL, or
 * null. The CLI reads the logs of the key's deployment, and the data sync of
 * the URL's, thus they must agree.
 */
export function keyMismatchWarning(key: string, url: string): string | null {
  const name = deploymentNameOfKey(key);
  if (name === null) {
    return null;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return host.split(".")[0] === name
    ? null
    : `CONVEX_DEPLOY_KEY is for the deployment "${name}", but the URL is ${url}.`;
}

/**
 * Where the recorder reads from. A local deployment is the default; a cloud
 * deployment is the alternative. Both differ only in where the URL and the
 * key come from.
 */
export type Target = "local" | "cloud";

/** What {@link resolveTarget} reads. */
export type TargetInput = {
  target: Target;
  /** The variables of the app's `.env` and `.env.local`. */
  appVariables: Record<string, string>;
  /** The environment of the recorder. */
  env: Record<string, string | undefined>;
  /** The `--url` flag. */
  url: string | undefined;
  /**
   * The `adminKey` of `<app>/.convex/local/default/config.json`, which
   * `npx convex dev` writes for a local deployment, or null.
   */
  localAdminKey: string | null;
};

/** The deployment to record, and the key to read it with. */
export type ResolvedTarget = { target: Target; url: string; key: string };

/** A deployment that the recorder cannot find, with what to do about it. */
export class TargetError extends Error {}

/**
 * The URL and the key of the deployment to record.
 *
 * - `local`: the URL is `--url`, `CONVEX_SELF_HOSTED_URL`, or the URL in the
 *   app's `.env.local`; the key is `CONVEX_SELF_HOSTED_ADMIN_KEY`, or the
 *   admin key that `npx convex dev` keeps for a local deployment.
 * - `cloud`: the URL is `--url` or the URL in the app's `.env.local`; the key
 *   is `CONVEX_DEPLOY_KEY`.
 */
export function resolveTarget(input: TargetInput): ResolvedTarget {
  const { target, appVariables, env } = input;
  const appUrl = deploymentUrlOf(appVariables);
  if (target === "cloud") {
    const key = env.CONVEX_DEPLOY_KEY;
    if (key === undefined || key === "") {
      throw new TargetError(
        "Set CONVEX_DEPLOY_KEY to a deploy key of the deployment (dashboard: Settings, then Deploy Keys). On cloud, the data sync API needs a Pro plan.",
      );
    }
    const url = input.url ?? appUrl;
    if (url === null) {
      throw new TargetError(
        "Found no deployment URL in the app's .env.local. Pass --url.",
      );
    }
    return { target, url: trimUrl(url), key };
  }
  const selfHostedKey = env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  const selfHostedUrl = env.CONVEX_SELF_HOSTED_URL;
  if (
    selfHostedKey === undefined &&
    appVariables.CONVEX_DEPLOYMENT !== undefined &&
    !isLocalDeployment(appVariables.CONVEX_DEPLOYMENT)
  ) {
    throw new TargetError(
      `The app's deployment is on cloud (CONVEX_DEPLOYMENT=${appVariables.CONVEX_DEPLOYMENT}). Pass --cloud and set CONVEX_DEPLOY_KEY, or run the app on a local deployment.`,
    );
  }
  const key = selfHostedKey ?? input.localAdminKey;
  if (key === null || key === "") {
    throw new TargetError(
      "Found no admin key of a local deployment. Run `npx convex dev` in the app once, or set CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY.",
    );
  }
  const url = input.url ?? selfHostedUrl ?? appUrl;
  if (url === null) {
    throw new TargetError(
      "Found no deployment URL in the app's .env.local. Run `npx convex dev` in the app once, or pass --url.",
    );
  }
  return { target, url: trimUrl(url), key };
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
