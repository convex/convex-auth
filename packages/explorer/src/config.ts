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
