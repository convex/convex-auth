/**
 * The provider settings of this component instance, from its env (set in the
 * app's `convex.config.ts`). The code of the app cannot change them when it
 * calls the component, thus a caller cannot point the component at a
 * different provider, or make it read the account id from a different field.
 *
 * @module
 */
import { env } from "./_generated/server.ts";
import {
  subClaimAccountId,
  userInfoFieldAccountId,
  type AccountIdRule,
} from "../../lib/oauth/dbHelpers.ts";

/** The provider settings of this component instance. */
export type ProviderConfig = {
  tokenEndpoint: string;
  issuers: string[] | undefined;
  userInfoEndpoints: Record<string, string> | undefined;
  accountId: AccountIdRule;
};

/**
 * Read and check the provider settings. Throws with the name of the variable
 * when a setting is missing or not valid.
 */
export function providerConfig(): ProviderConfig {
  const tokenEndpoint = requireHttpsUrl("TOKEN_ENDPOINT", env.TOKEN_ENDPOINT);

  const issuers =
    env.ISSUERS === undefined || env.ISSUERS.trim() === ""
      ? undefined
      : env.ISSUERS.split(",").map((issuer) => issuer.trim());
  if (issuers?.some((issuer) => issuer === "")) {
    throw new Error(
      "ISSUERS has an empty value. Separate issuers with commas.",
    );
  }

  let userInfoEndpoints: Record<string, string> | undefined;
  if (env.USERINFO_ENDPOINTS !== undefined && env.USERINFO_ENDPOINTS !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.USERINFO_ENDPOINTS);
    } catch {
      parsed = null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        'USERINFO_ENDPOINTS must be a JSON object, for example {"user":"https://provider.example/user"}.',
      );
    }
    userInfoEndpoints = Object.fromEntries(
      Object.entries(parsed).map(([key, url]) => [
        key,
        requireHttpsUrl(`USERINFO_ENDPOINTS.${key}`, url),
      ]),
    );
  }

  return {
    tokenEndpoint,
    issuers,
    userInfoEndpoints,
    accountId: accountIdRule(env.ACCOUNT_ID_FIELD, userInfoEndpoints),
  };
}

/**
 * The account id rule from `ACCOUNT_ID_FIELD`:
 *
 * - not set, or `sub`: the `sub` claim of the id_token.
 * - `<endpoint>.<field>`: the field of a userinfo response, for example
 *   `user.id` for the `id` field of the `user` response.
 */
function accountIdRule(
  field: string | undefined,
  userInfoEndpoints: Record<string, string> | undefined,
): AccountIdRule {
  if (field === undefined || field === "" || field === "sub") {
    return subClaimAccountId;
  }
  const dot = field.indexOf(".");
  const endpoint = field.slice(0, dot);
  const name = field.slice(dot + 1);
  if (dot <= 0 || name === "" || userInfoEndpoints?.[endpoint] === undefined) {
    throw new Error(
      `ACCOUNT_ID_FIELD must be "sub" or "<endpoint>.<field>" with an ` +
        `endpoint of USERINFO_ENDPOINTS, got ${JSON.stringify(field)}.`,
    );
  }
  return userInfoFieldAccountId(endpoint, name);
}

function requireHttpsUrl(name: string, value: unknown): string {
  let url: URL | null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {
    url = null;
  }
  if (url === null || url.protocol !== "https:") {
    throw new Error(
      `${name} must be an https URL, got ${JSON.stringify(value)}.`,
    );
  }
  return value as string;
}
