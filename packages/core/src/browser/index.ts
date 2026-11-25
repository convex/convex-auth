/**
 * Framework-agnostic browser building blocks for Convex Auth clients: a token
 * storage abstraction, a cross-tab refresh mutex, and the session manager that
 * ties them together. The React bindings (`@convex-dev/auth/react`) build on
 * these, and other client libraries can too.
 *
 * A binding for another framework (Svelte, Vue, Solid, …) creates one
 * {@link AuthClient}, binds its state to the framework, and hands the
 * client and an {@link AuthSignInApi} to the method clients of
 * `@convex-dev/auth/methods/<method>/browser`. Their state is a
 * {@link ReadableStore}, which the binding subscribes to.
 *
 * @module
 */

export {
  type TokenStorage,
  type SignInStorage,
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
export type {
  AmbientSignInClient,
  AmbientSignInContext,
  AuthSignInApi,
  ConvexMutationApi,
  SignInFunction,
} from "./ambientSignInClient.ts";
export type { SignInValues, SignInValuesReader } from "./keyedStore.ts";
export type { ReadableStore } from "./store.ts";
