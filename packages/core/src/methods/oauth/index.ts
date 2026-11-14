/**
 * The OAuth client without React, exported at `@convex-dev/auth/methods/oauth`.
 * Register {@link oauth} with the `AuthClient` of `@convex-dev/auth/browser`,
 * then read what it publishes under {@link OAUTH_SETUP_ID}. The React hooks of
 * the OAuth providers are built on it.
 *
 * @module
 */

export {
  oauth,
  OAUTH_SETUP_ID,
  OAUTH_ACTIONS_KEY,
  OAUTH_FLOW_ERROR_KEY,
  type OauthActions,
  type OauthCompleteResult,
  type OauthFlowError,
  type OauthProviderApi,
  type OauthProviderRefs,
  type OauthStartResult,
  type SignInOptions,
} from "./client.ts";
