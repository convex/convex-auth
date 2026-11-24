/**
 * Framework-agnostic browser building blocks for Convex Auth clients: a token
 * storage abstraction, a cross-tab refresh mutex, and the session manager that
 * ties them together. The React bindings (`@convex-dev/auth/react`) build on
 * these, and other client libraries can too.
 *
 * Create the auth client with {@link createAuthClient}.
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
} from "./createAuthClient.ts";
