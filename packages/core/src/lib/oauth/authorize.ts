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
  RegisteredMutation,
} from "convex/server";
import { v } from "convex/values";
import type { ObjectType, PropertyValidators } from "convex/values";
import { sha256Hex } from "../crypto.ts";
import { generateRandomToken, sha256Base64Url } from "./crypto.ts";
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
export function buildStartSignIn<
  StartArgs extends PropertyValidators = Record<never, never>,
>(options: {
  /**
   * The origins `redirectTo` may point at, validated and normalized. It is a
   * function so an app can read them when the mutation runs, not when the
   * module loads.
   */
  allowedOrigins: () => string[];
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
   * Arguments `startSignIn` takes beyond `redirectTo`, such as the
   * organization a WorkOS sign-in is routed to. Only `authorizationParams`
   * reads them.
   */
  startArgs?: StartArgs;
  /**
   * Build the parameters the provider's authorization endpoint takes beyond
   * the standard ones from the `startArgs`. It throws to refuse them, before
   * anything is written. A standard parameter always wins over one of these.
   */
  authorizationParams?: (
    args: ObjectType<StartArgs>,
  ) => Readonly<Record<string, string>>;
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
}): RegisteredMutation<
  "public",
  { redirectTo: string } & ObjectType<StartArgs>,
  Promise<{ redirect: string; state: string }>
> {
  return mutationGeneric({
    args: {
      ...options.startArgs,
      redirectTo: v.string(),
    },
    returns: v.object({ redirect: v.string(), state: v.string() }),
    handler: async (
      ctx,
      args: { redirectTo: string } & ObjectType<StartArgs>,
    ) => {
      const extraParams = options.authorizationParams?.(args) ?? {};
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null) {
        throw new Error("redirectTo must be an absolute URL");
      }
      if (!options.allowedOrigins().includes(redirectTo.origin)) {
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

      const params: Record<string, string> = {
        ...extraParams,
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
