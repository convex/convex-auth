import type { AuthCore } from "../../server/setup.ts";
import type { ComponentApi } from "../../components/oauth/_generated/component.ts";
import { buildStartSignIn } from "../../lib/oauth/authorize.ts";
import type { CallbackMethod } from "../../lib/oauth/http.ts";
import {
  buildCompleteSignIn,
  parseUrl,
  validateAllowedRedirectOrigins,
  type OidcClaims,
  type TicketPayload,
} from "../../lib/oauth/redemption.ts";

export type { OidcClaims };

/**
 * Map what the provider attested about the user to the account identity used
 * at redemption. `claims` holds the id_token claims (`undefined` for
 * non-OIDC providers). `userInfoResponses` holds the userinfo responses
 * keyed as configured (`undefined` unless the catalog sets
 * `userInfoEndpoints`). `id` becomes the provider account id.
 *
 * `Profile` is the exact shape the mapping emits, which is what the app's
 * create-or-update-user callback receives.
 *
 * `UserInfo` is the catalog's declared shape for the userinfo responses,
 * keyed like `userInfoEndpoints`. It types what the provider is trusted to
 * return. The responses are provider-attested JSON and are not validated
 * against it at runtime.
 */
export type OauthProfile<
  Profile extends { id: string } = { id: string } & Record<string, unknown>,
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
> = (
  claims: OidcClaims | undefined,
  userInfoResponses: UserInfo | undefined,
) => Profile;

/**
 * Provider-defined config for interacting with an individual OAuth provider.
 *
 * `UserInfo` declares the shape of the userinfo responses, tying
 * `userInfoEndpoints` keys to what `profile` receives (see
 * {@link OauthProfile}).
 */
export type OauthCatalog<
  Profile extends { id: string } = { id: string } & Record<string, unknown>,
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
> = {
  /**
   * The provider's authorization endpoint (a full URL), e.g. Google's
   * `https://accounts.google.com/o/oauth2/v2/auth`.
   */
  authorizationEndpoint: string;
  /**
   * The provider's token endpoint (a full URL), e.g. Google's
   * `https://oauth2.googleapis.com/token`.
   */
  tokenEndpoint: string;
  /**
   * Expected `iss` (the OIDC issuer claim) of the provider's id_tokens, e.g.
   * Google's `https://accounts.google.com`. Some providers document more than
   * one form (Google also uses `accounts.google.com`); an array accepts any
   * of them. Present for OIDC providers; absent for plain-OAuth providers
   * (e.g., GitHub), where identity comes from userinfo.
   *
   * All values must name the same issuing authority (aliases, or an issuer
   * URL migration). Multiple values should only be used when a single provider
   * has multiple potential issuer values, but is guaranteed to provide the same
   * sub for a given account. Multiple issuers that use different `sub` values
   * can lead to users being logged into the wrong account.
   */
  issuer?: string | string[];
  /**
   * Endpoints (full URLs) the callback fetches with the access token (GET
   * with a bearer token), keyed by the name the `profile` mapping reads
   * each response under. Present for providers whose identity comes from
   * userinfo (GitHub). The keys must match `UserInfo`'s.
   */
  userInfoEndpoints?: { [K in keyof UserInfo & string]: string };
  /** Scopes to request. */
  scopes: string[];
  /**
   * The method the provider delivers the callback with. `"GET"` (the default)
   * is a redirect with the parameters in the query string. `"POST"` asks the
   * provider for a form submission with the parameters as form fields, which
   * some providers require.
   */
  callbackMethod?: CallbackMethod;
  /** Map the provider's attested identity to the account profile. */
  profile: OauthProfile<Profile, UserInfo>;
};

/**
 * App-defined config for setting up an OAuth provider and passing in options.
 */
export type OauthProviderOptions = {
  /**
   * This provider's oauth component instance, e.g. `components.authAcme`.
   * The component is installed once per provider.
   */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/**
 * Set up OAuth sign-in against a single upstream identity provider.
 *
 * The flow:
 *
 * 1. `startSignIn` (here): validate, mint `state`, record an authorization
 *    request in the component, and return the provider authorization URL for
 *    the client to navigate to plus the state it must hold onto.
 * 2. The provider sends the callback to the component's HTTP endpoint
 *    (`<site><httpPrefix>/callback`), and it claims the request, exchanges
 *    the code, and mints a one-time ticket.
 * 3. `completeSignIn` (here): the client presents the one-time code from the
 *    callback redirect plus its original state, and gets back the session
 *    token bundle.
 */
export function setupOauth<
  Provider extends string,
  Profile extends { id: string },
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
>(
  core: AuthCore,
  providerName: Provider,
  catalog: OauthCatalog<Profile, UserInfo>,
  options: OauthProviderOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time, not on the first sign-in.
  const allowedOrigins = validateAllowedRedirectOrigins(
    options.allowedRedirectOrigins,
  );
  const issuers =
    catalog.issuer === undefined
      ? undefined
      : Array.isArray(catalog.issuer)
        ? catalog.issuer
        : [catalog.issuer];
  // Per OIDC, requesting the `openid` scope makes the provider return an
  // id_token, which must be validated against an expected issuer.
  if (catalog.scopes.includes("openid") && (issuers?.length ?? 0) === 0) {
    throw new Error(
      `Provider "${providerName}" requests the "openid" scope, so the provider will return an id_token, but its catalog sets no issuer to validate it against`,
    );
  }
  // Catalog endpoints must use https. Plain http is allowed on a loopback
  // host for local testing.
  const endpoints: [string, string][] = [
    ["authorizationEndpoint", catalog.authorizationEndpoint],
    ["tokenEndpoint", catalog.tokenEndpoint],
    ...Object.entries(catalog.userInfoEndpoints ?? {}).map(
      ([key, endpoint]): [string, string] => [
        `userInfoEndpoints.${key}`,
        endpoint,
      ],
    ),
  ];
  for (const [field, endpoint] of endpoints) {
    const url = parseUrl(endpoint);
    const secure =
      url?.protocol === "https:" ||
      (url?.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
    if (!secure) {
      throw new Error(
        `Provider "${providerName}" catalog ${field} is not a valid https URL: ` +
          `"${endpoint}" (plain http is only allowed for localhost and 127.0.0.1)`,
      );
    }
  }

  const { authMutation } = core.bindProvider<Provider, Profile>({
    name: providerName,
  });

  const startSignIn = buildStartSignIn({
    allowedOrigins,
    authorizationEndpoint: catalog.authorizationEndpoint,
    scopes: catalog.scopes,
    callbackMethod: catalog.callbackMethod,
    createAuthorizationRequest: (ctx, args) =>
      ctx.runMutation(options.component.provider.createAuthorizationRequest, {
        providerName,
        stateHash: args.stateHash,
        redirectTo: args.redirectTo,
        codeVerifier: args.codeVerifier,
        tokenEndpoint: catalog.tokenEndpoint,
        userInfoEndpoints: catalog.userInfoEndpoints,
        issuers,
      }),
  });

  /**
   * Complete an OAuth sign-in by redeeming the one-time `code` from the
   * callback redirect together with the state held since `startSignIn`.
   */
  const completeSignIn = buildCompleteSignIn<Profile, TicketPayload<UserInfo>>({
    providerName,
    authMutation,
    claimTicket: (ctx, args) =>
      ctx.runMutation(options.component.provider.claimTicket, {
        providerName,
        ...args,
      }),
    profile: (payload) =>
      catalog.profile(payload.claims, payload.userInfoResponses),
  });

  return { startSignIn, completeSignIn };
}
