/**
 * Framework-agnostic browser code for Convex Auth clients. Create the auth
 * client with {@link createAuthClient}. The React bindings
 * (`@convex-dev/auth/react`) build on this module, and other client libraries
 * can too.
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
