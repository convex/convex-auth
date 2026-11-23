/**
 * Framework-agnostic browser building blocks for Convex Auth clients: a token
 * storage abstraction, a cross-tab refresh mutex, the session manager that
 * ties them together, and {@link createAuthClient}, which builds a session
 * manager from a Convex client. The React bindings (`@convex-dev/auth/react`) build on
 * these, and other client libraries can too.
 *
 * @module
 */

export {
  type TokenStorage,
  InMemoryStorage,
  defaultStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage.ts";
export { runWithMutex } from "./mutex.ts";
export {
  AuthClient,
  type SpaAuthApi,
  type SsrAuthApi,
  type AuthClientConfig,
  type AuthState,
} from "./sessionManager.ts";
export {
  createAuthClient,
  type CreateAuthClientOptions,
  type DeploymentUrlOption,
} from "./createAuthClient.ts";
export type { ConvexClientApi } from "./convexClient.ts";
export type { AuthSignInApi } from "./ambientSignInClient.ts";
