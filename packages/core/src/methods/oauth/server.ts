/**
 * The generic `oauth` sign-in method, for identity providers without a
 * built-in method.
 *
 * @internal Not public until the API for custom OAuth providers is stable.
 * @module
 */
import type { UserCallbacks } from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import type { ComponentApi } from "../../components/oauth/_generated/component.ts";
import { buildStartSignIn } from "../../lib/oauth/authorize.ts";
import type { CallbackMethod } from "../../lib/oauth/http.ts";
import {
  buildAttestedCompleteSignIn,
  parseUrl,
  validateAllowedRedirectOrigins,
  type OidcClaims,
  type TicketPayload,
} from "../../lib/oauth/redemption.ts";

export type { OidcClaims };

/**
 * Map what the provider attested about the user to the profile that the app's
 * callbacks receive. `claims` holds the id_token claims (`undefined` for
 * non-OIDC providers). `userInfoResponses` holds the userinfo responses
 * keyed as configured (`undefined` unless the component sets
 * `USERINFO_ENDPOINTS`). `id` must be the account id that the component
 * reads with its `ACCOUNT_ID_FIELD`; redemption throws when they differ.
 *
 * `Profile` is the exact shape the mapping emits, which is what the app's
 * create-or-update-user callback receives.
 *
 * `UserInfo` is the catalog's declared shape for the userinfo responses,
 * keyed like `USERINFO_ENDPOINTS`. It types what the provider is trusted to
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
 * The token endpoint, the issuers, the userinfo endpoints, and the field of
 * the account id are not here: they are in the env of the oauth component
 * instance (see `components/oauth/convex.config.ts`), thus the code of the
 * app cannot change them when it calls the component.
 *
 * `UserInfo` declares the shape of the userinfo responses, keyed like the
 * `USERINFO_ENDPOINTS` of the component, which `profile` receives (see
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
 * App-defined config for setting up the `oauth` method for one OAuth provider.
 */
export type OauthOptions = {
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
 *
 * @internal Not public until the API for custom OAuth providers is stable.
 */
export function setupOauth<
  Provider extends string,
  Profile extends { id: string },
  UsersTable extends string,
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
>(
  core: AuthCore<UsersTable>,
  providerName: Provider,
  catalog: OauthCatalog<Profile, UserInfo>,
  callbacks: UserCallbacks<Provider, Profile, UsersTable>,
  options: OauthOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time, not on the first sign-in.
  const allowedOrigins = validateAllowedRedirectOrigins(
    options.allowedRedirectOrigins,
  );
  // The authorization endpoint must use https. Plain http is allowed on a
  // loopback host for local testing. The component checks the other
  // endpoints, which come from its env.
  const endpoints: [string, string][] = [
    ["authorizationEndpoint", catalog.authorizationEndpoint],
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

  const { authMutation } = core.bindMethod({
    name: providerName,
    createUser: callbacks.createUser,
    onSignIn: callbacks.onSignIn,
  });

  const startSignIn = buildStartSignIn({
    providerName,
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
      }),
  });

  /**
   * Complete an OAuth sign-in by redeeming the one-time `code` from the
   * callback redirect together with the state held since `startSignIn`.
   */
  const completeSignIn = buildAttestedCompleteSignIn<
    Profile,
    TicketPayload<UserInfo>
  >({
    providerName,
    authMutation,
    redeemTicket: (ctx, args) =>
      ctx.runMutation(options.component.provider.redeemTicket, {
        providerName,
        ...args,
      }),
    linkAccount: (ctx, args) =>
      ctx.runMutation(options.component.provider.linkAccount, args),
    profile: (payload) =>
      catalog.profile(payload.claims, payload.userInfoResponses),
  });

  return { startSignIn, completeSignIn };
}
