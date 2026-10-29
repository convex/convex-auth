/**
 * Shared test setup for the OAuth client and its React hooks.
 *
 * @module
 */
import { getFunctionName, makeFunctionReference } from "convex/server";
import { vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import { AuthClient } from "../../browser/sessionManager.ts";
import {
  InMemoryStorage,
  NamespacedStorage,
  type TokenStorage,
} from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import {
  OAUTH_ACTIONS_KEY,
  OAUTH_FLOW_ERROR_KEY,
  OAUTH_SETUP_ID,
  oauth,
  type OauthActions,
  type OauthFlowError,
  type OauthProviderRefs,
  type PendingFlow,
} from "./client.ts";

/** The deployment url the tests namespace their storage under. */
export const NAMESPACE = "https://happy-animal-123.convex.cloud";

/** A session for the sign-in mutations to resolve with. */
export const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

/** The envelope `completeSignIn` returns once a code redeems. */
export const completed = { status: "complete" as const, tokens: bundle };

/**
 * The envelope `completeSignIn` returns for a code that cannot be redeemed:
 * unknown, already spent, expired, or paired with someone else's state.
 */
export const invalidCode = {
  status: "error" as const,
  userError: { error: "INVALID_CODE" as const },
};

/**
 * A stand-in provider, for tests that don't care which provider ran. The refs
 * have paths that look like an app's because `signIn` saves the completeSignIn
 * path and completion rebuilds the reference from it, so assertions compare
 * paths, not references.
 */
export const acmeRefs: OauthProviderRefs = {
  providerName: "acme",
  startSignIn: makeFunctionReference<"mutation">("auth:startSignInWithAcme"),
  completeSignIn: makeFunctionReference<"mutation">(
    "auth:completeSignInWithAcme",
  ),
};

/** The oauth setup's scoped storage view over `storage`. */
export function flowStorage(storage: TokenStorage) {
  return new NamespacedStorage(storage, NAMESPACE).forSignIn(OAUTH_SETUP_ID);
}

/**
 * The pending flow as stored, or null. Only works with a storage that reads
 * synchronously, like `InMemoryStorage`, because it does not await the read.
 */
export function readFlow(storage: TokenStorage): PendingFlow | null {
  const raw = flowStorage(storage).get("flow") as string | null | undefined;
  if (raw === null || raw === undefined) {
    return null;
  }
  return JSON.parse(raw) as PendingFlow;
}

/** Store a pending flow the way `signIn` would before navigating away. */
export function seedPendingFlow(
  storage: TokenStorage,
  refs: OauthProviderRefs = acmeRefs,
  state = "state-1",
): void {
  void flowStorage(storage).set(
    "flow",
    JSON.stringify({
      providerName: refs.providerName,
      state,
      completeSignIn: getFunctionName(refs.completeSignIn),
    } satisfies PendingFlow),
  );
}

/**
 * An AuthClient with the real oauth setup registered, plus mocks standing in
 * for the Convex calls: `mutation` behind the sign-in api (completing a flow)
 * and `convexMutation` behind the plain Convex caller (starting one). Each
 * records the function reference it was called with, so tests can assert which
 * function ran.
 */
export function oauthClient(storage: TokenStorage): {
  client: AuthClient;
  signInApi: AuthSignInApi;
  mutation: ReturnType<typeof vi.fn>;
  convexMutation: ReturnType<typeof vi.fn>;
} {
  const mutation = vi.fn();
  const signInApi = { mutation, action: vi.fn() } as unknown as AuthSignInApi;
  const convexMutation = vi.fn();
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage,
    storageNamespace: NAMESPACE,
    ambientSignIns: {
      signIns: [oauth()],
      signInApi,
      convex: { mutation: convexMutation },
    },
  });
  return { client, signInApi, mutation, convexMutation };
}

/** {@link oauthClient} plus the values the oauth setup published. */
export function setupOAuth({
  storage = new InMemoryStorage() as TokenStorage,
} = {}) {
  const { client, mutation, convexMutation } = oauthClient(storage);
  const oauthValues = client.ambientSignInValues(OAUTH_SETUP_ID);
  const actions = oauthValues.get<OauthActions>(OAUTH_ACTIONS_KEY)!;
  const flowError = () =>
    oauthValues.get<OauthFlowError | null>(OAUTH_FLOW_ERROR_KEY);
  return { client, mutation, convexMutation, actions, flowError, storage };
}

/** The function path the `mutation` mock was called with. */
export function calledPath(
  mutation: ReturnType<typeof vi.fn>,
  call = 0,
): string {
  return getFunctionName(mutation.mock.calls[call]![0] as never);
}

/**
 * Take the client's React Native branch, which returns the redirect url
 * instead of navigating. jsdom has a location, so without this the client
 * would try to navigate and jsdom would log a not-implemented error.
 */
export function stubReactNative(): void {
  Object.defineProperty(window.navigator, "product", {
    value: "ReactNative",
    configurable: true,
  });
}

/**
 * Undo {@link stubReactNative}. jsdom keeps `product` on `Navigator.prototype`,
 * so deleting the stubbed own property reveals the real value again.
 */
export function restoreNavigatorProduct(): void {
  delete (window.navigator as { product?: string }).product;
}
