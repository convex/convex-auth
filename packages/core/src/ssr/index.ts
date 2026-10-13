/**
 * Framework-agnostic server (SSR) building blocks for Convex Auth: a cookie
 * abstraction, a WHATWG `Request`/`Response` cookie adapter, access-token
 * inspection, the {@link ServerAuthSession} that owns the refresh lifecycle,
 * the {@link createServerAuthChecker} that verifies an access token against the
 * backend, the method-agnostic `(Request) => Response` refresh/sign-out
 * handlers, the {@link convexProxyHandler} that serves sign-in, and the
 * {@link setupConvexAuthServer} factory that configures them all once.
 *
 * @module
 */

export {
  type AuthCookieOptions,
  type CookieDeleteOptions,
  type CookieOptions,
  type CookieStore,
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies.ts";
export {
  type HttpCookies,
  httpCookies,
  serializeCookie,
} from "./httpCookies.ts";
export { isTrustedOrigin } from "./origin.ts";
export {
  type RefreshHandlerConfig,
  type RequestHandler,
  type SignOutHandlerConfig,
  refreshHandler,
  signOutHandler,
} from "./handlers.ts";
export { type ConvexAuthServerConfig, setupConvexAuthServer } from "./setup.ts";
export {
  type ConvexProxyConfig,
  type ExposedSignInFn,
  convexProxyHandler,
} from "./signInProxy.ts";
export {
  type DecodedAccessToken,
  decodeAccessToken,
  isTokenExpiring,
} from "./jwt.ts";
export {
  ServerAuthSession,
  type RefreshSession,
  type ServerAuthSessionConfig,
} from "./session.ts";
export {
  createServerAuthChecker,
  type ServerAuthChecker,
  type ServerAuthCheckerConfig,
} from "./isAuthenticated.ts";
export type {
  AuthSessionResponse,
  ClientView,
  ConvexAuthApi,
  IsAuthenticatedFn,
  RefreshSessionFn,
  SignInComplete,
  SignInEnvelope,
  SignInError,
  SignInStatus,
  SignOutFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
export { makeSlimBundle } from "../lib/types.ts";
