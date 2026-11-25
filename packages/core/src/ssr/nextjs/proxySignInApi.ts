import type { ConvexHttpClient } from "convex/browser";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { AuthClient } from "../../browser/sessionManager.ts";

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
  return {
    mutation: (fn, args) => withAuth().mutation(fn, args),
    action: (fn, args) => withAuth().action(fn, args),
  };
}
