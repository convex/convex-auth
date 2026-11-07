/**
 * The app-side start of an OAuth flow, shared by every provider.
 *
 * Every provider does the same three things here: check where the flow is
 * allowed to return to, mint the state that ties the callback back to this
 * client, and build the URL to send the browser to. What differs is the
 * endpoint and the scopes.
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import type {
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import { sha256Hex } from "../crypto.ts";
import { generateRandomToken, sha256Base64Url } from "./crypto.ts";
import { CALLBACK_PATH } from "./constants.ts";
import type { CallbackMethod } from "./http.ts";
import { parseUrl } from "./redemption.ts";

type MutationCtx = GenericMutationCtx<GenericDataModel>;

type CreateAuthorizationRequestArgs = {
  stateHash: string;
  redirectTo: string;
  codeVerifier: string;
};

type CreateAuthorizationRequestResult = {
  clientId: string;
  callbackUrl: string;
};

type CreateAuthorizationRequestRef = FunctionReference<
  "mutation",
  "internal",
  CreateAuthorizationRequestArgs,
  CreateAuthorizationRequestResult
>;

/**
 * Build a provider's `startSignIn` mutation.
 *
 * The server mints `state` and returns it; the client keeps it (it must
 * present the same value again to complete sign-in) and navigates to the
 * returned `redirect` URL.
 *
 * The mutation throws on every error. They are all developer or environment
 * errors, such as a `redirectTo` origin that isn't allowed, so there is
 * nothing for the user to correct.
 */
export function buildStartSignIn(options: {
  /** The provider's name, used in error messages. */
  providerName: string;
  /** Origins `redirectTo` may point at, already validated and normalized. */
  allowedOrigins: string[];
  /** The provider's authorization endpoint (a full URL). */
  authorizationEndpoint: string;
  /** Scopes to request. Left off the URL entirely when empty. */
  scopes: readonly string[];
  /**
   * The method the provider delivers the callback with. `"POST"` adds
   * `response_mode=form_post` to the authorization URL.
   */
  callbackMethod?: CallbackMethod;
  /**
   * Record the request in the provider's component, and return what the
   * authorization URL needs.
   *
   * If the component's `createAuthorizationRequest` mutation takes exactly
   * {@link CreateAuthorizationRequestArgs}, pass its reference. If the
   * mutation takes more fields, pass a function that runs it with those
   * fields added.
   */
  createAuthorizationRequest:
    | CreateAuthorizationRequestRef
    | ((
        ctx: MutationCtx,
        args: CreateAuthorizationRequestArgs,
      ) => Promise<CreateAuthorizationRequestResult>);
}) {
  return mutationGeneric({
    args: {
      redirectTo: v.string(),
    },
    returns: v.object({ redirect: v.string(), state: v.string() }),
    handler: async (ctx, args) => {
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null) {
        throw new Error("redirectTo must be an absolute URL");
      }
      if (!options.allowedOrigins.includes(redirectTo.origin)) {
        throw new Error(
          `redirectTo origin "${redirectTo.origin}" is not in allowedRedirectOrigins`,
        );
      }

      const state = generateRandomToken();
      const codeVerifier = generateRandomToken();
      const requestArgs = {
        stateHash: await sha256Hex(state),
        redirectTo: args.redirectTo,
        codeVerifier,
      };
      // A function reference is a plain object at runtime, so `typeof` is
      // what tells the two apart.
      const { clientId, callbackUrl } =
        typeof options.createAuthorizationRequest === "function"
          ? await options.createAuthorizationRequest(ctx, requestArgs)
          : await ctx.runMutation(
              options.createAuthorizationRequest,
              requestArgs,
            );
      assertCallbackUnderHttpPrefix(options.providerName, callbackUrl);

      const params: Record<string, string> = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
        // Every provider gets a challenge. One that does not implement PKCE
        // ignores the parameters, which RFC 6749 requires of it.
        code_challenge: await sha256Base64Url(codeVerifier),
        code_challenge_method: "S256",
      };
      if (options.scopes.length > 0) {
        params.scope = options.scopes.join(" ");
      }
      if (options.callbackMethod === "POST") {
        params.response_mode = "form_post";
      }

      const url = new URL(options.authorizationEndpoint);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      return { redirect: url.toString(), state };
    },
  });
}

/**
 * Refuse a callback URL with no `httpPrefix` in front of `/callback`.
 *
 * The component reads its callback URL from its own `CONVEX_SITE_URL`, which
 * the backend presents with the component's `httpPrefix` applied. A component
 * installed without an `httpPrefix`, or with one that another component
 * already uses, has no HTTP routes mounted, so its callback URL is the bare
 * `<site>/callback`, which 404s. Convex Auth cannot see the `httpPrefix` when
 * the app deploys (`CONVEX_SITE_URL` has no prefix while modules load), so
 * this is the earliest point the mistake shows.
 */
function assertCallbackUnderHttpPrefix(
  providerName: string,
  callbackUrl: string,
): void {
  if (new URL(callbackUrl).pathname !== CALLBACK_PATH) return;
  throw new Error(
    `The OAuth component of provider "${providerName}" is not served under ` +
      `an httpPrefix, so its callback URL would be ${callbackUrl}, which ` +
      `returns 404. In convex/convex.config.ts, install the component with ` +
      `its own httpPrefix, e.g. \`app.use(component, { httpPrefix: ` +
      `"/oauth/${providerName}", ... })\`. Each OAuth component needs a ` +
      `different httpPrefix.`,
  );
}
