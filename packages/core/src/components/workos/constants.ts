/**
 * Everything about WorkOS that never varies between apps: the SSO endpoints,
 * the shape of the SSO profile, the REST API's base URL, and the events the
 * webhook applies.
 *
 * Sign-in goes through WorkOS's standalone SSO API, not AuthKit (User
 * Management). The SSO API creates no WorkOS users and no WorkOS sessions, so
 * the session stays Convex Auth's alone.
 *
 * @module
 */

/** Where the browser is sent to sign in. */
export const AUTHORIZATION_ENDPOINT = "https://api.workos.com/sso/authorize";

/** Where the authorization code is exchanged for an access token. */
export const TOKEN_ENDPOINT = "https://api.workos.com/sso/token";

/**
 * What the callback fetches with the access token. WorkOS returns no
 * id_token; the profile endpoint is where identity comes from.
 */
export const USER_INFO_ENDPOINTS: Record<keyof WorkosUserInfo, string> = {
  profile: "https://api.workos.com/sso/profile",
};

/** The SSO API takes no scopes: the connection decides what is returned. */
export const SCOPES: string[] = [];

/** The name this method's accounts are namespaced under in the core. */
export const PROVIDER_NAME = "workos";

/** The WorkOS SSO profile fields the mapping reads. */
type WorkosSsoProfile = {
  id: string;
  idp_id: string;
  organization_id?: string | null;
  connection_id: string;
  connection_type: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
};

/**
 * The responses the userinfo endpoints produce, keyed the way
 * {@link USER_INFO_ENDPOINTS} names them. This is what WorkOS is trusted to
 * return; the mapping checks the fields it relies on.
 */
export type WorkosUserInfo = { profile: WorkosSsoProfile };

/** WorkOS's REST API, for the webhook, reconcile and the portal. */
export const API_BASE = "https://api.workos.com";

/** The events the webhook applies, and the endpoint is subscribed to. */
export const EVENTS = [
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_domain.created",
  "organization_domain.updated",
  "organization_domain.verified",
  "organization_domain.verification_failed",
  "organization_domain.deleted",
  "connection.activated",
  "connection.deactivated",
  "connection.deleted",
  "dsync.activated",
  "dsync.deleted",
  "dsync.user.created",
  "dsync.user.updated",
  "dsync.user.deleted",
  "dsync.group.created",
  "dsync.group.updated",
  "dsync.group.deleted",
  "dsync.group.user_added",
  "dsync.group.user_removed",
] as const;

/**
 * How many WorkOS objects one page holds. A page is applied in one mutation,
 * and each change in it may run the app's handler in that transaction.
 */
export const PAGE_SIZE = 50;

/** Rows one removal step removes in one mutation. */
export const BATCH = 100;
