import type { ConvexHttpClient } from "convex/browser";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import { runWithMutex } from "../../browser/mutex.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";
import { REFRESH_TOKEN_STORAGE_KEY } from "../../browser/storage.ts";

/** The calls `proxySignInApi` makes on its `ConvexHttpClient`. */
export type ProxyClient = Pick<
  ConvexHttpClient,
  "mutation" | "action" | "setAuth" | "clearAuth"
>;

/**
 * The {@link AuthSignInApi} of `ConvexAuthNextjsProvider`: sign-in functions
 * run through the auth proxy, which moves the minted refresh token into an
 * httpOnly cookie.
 *
 * Each call attaches the current access token: a sign-in typically runs
 * unauthenticated, but a function may want the existing identity (e.g. to
 * link an account to the signed-in user). `authClient` is a getter because
 * the provider builds this api before its `AuthClient`, which hands the api
 * to its ambient setups from inside its constructor.
 *
 * Each call holds the `AuthClient`'s refresh lock. The proxy's response sets
 * the auth cookies, and so does the refresh handler's. A refresh sent before
 * the sign-in carries the old cookie, and if its response arrives after the
 * sign-in's, its `Set-Cookie` puts the old session back.
 */
export function proxySignInApi(
  proxy: ProxyClient,
  authClient: () => AuthClient,
): AuthSignInApi {
  const withAuth = () => {
    const token = authClient().getAccessToken();
    if (token !== null) proxy.setAuth(token);
    else proxy.clearAuth();
    return proxy;
  };
  const locked = <T>(call: () => Promise<T>) =>
    runWithMutex(authClient().storage.key(REFRESH_TOKEN_STORAGE_KEY), call);
  return {
    mutation: (fn, args) => locked(() => withAuth().mutation(fn, args)),
    action: (fn, args) => locked(() => withAuth().action(fn, args)),
  };
}
