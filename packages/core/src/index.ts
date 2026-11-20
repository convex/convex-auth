/**
 * The types that the Convex backend and the clients of Convex Auth share,
 * exported at `@convex-dev/auth`. This entry point holds only types, thus
 * any runtime can import it.
 *
 * @module
 */

export type {
  AuthorizeImpersonationFn,
  ConvexAuthApi,
  Impersonation,
  ImpersonateUserFn,
  ImpersonateUserResult,
  IsAuthenticatedFn,
  RefreshResult,
  RefreshSessionFn,
  SignInComplete,
  SignInEnvelope,
  SignInError,
  SignOutFn,
  StopImpersonatingFn,
  StopImpersonatingResult,
  TokenBundle,
} from "./lib/types.ts";
