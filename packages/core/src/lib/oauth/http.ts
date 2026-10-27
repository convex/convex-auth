/**
 * The callback route every OAuth component serves.
 *
 * A component's `http.ts` hands this its provider's configuration and gets
 * back the router it default-exports. This owns the transport around
 * {@link runCallback}: which methods the callback is served over, where the
 * parameters are read from, and which status the redirect back to the app
 * uses.
 *
 * @module
 */
import {
  httpActionGeneric,
  httpRouter,
  type GenericActionCtx,
  type GenericDataModel,
  type HttpRouter,
} from "convex/server";
import {
  invalidCallbackResponse,
  runCallback,
  type CallbackRequestParams,
  type ClaimedRequest,
  type ClaimResult,
  type ExchangeConfig,
  type MintedTicket,
} from "./callback.ts";
import { CALLBACK_PATH } from "./constants.ts";

type ActionCtx = GenericActionCtx<GenericDataModel>;

/**
 * How a provider delivers the callback. A GET is a redirect with the
 * parameters in the query string. A POST is a form submission with the
 * parameters as form fields.
 */
export type CallbackMethod = "GET" | "POST";

/**
 * Build the router a component's `http.ts` default-exports. The callback is
 * served at `/callback`, under whichever `httpPrefix` the app installed the
 * component with.
 *
 * Each provider's component customizes the callback through these options,
 * such as its token endpoint and the methods the callback is served over.
 *
 * ```ts skip-check
 * const http = buildCallbackRouter<ClaimedRequest>({
 *   claim: (ctx, stateHash) =>
 *     ctx.runMutation(internal.provider.claimAuthorizationRequest, {
 *       stateHash,
 *     }),
 *   mintTicket: (ctx, request, ticket) =>
 *     ctx.runMutation(internal.provider.createTicket, {
 *       stateHash: request.stateHash,
 *       ...ticket,
 *     }),
 *   exchangeConfig: () => ({
 *     providerName: PROVIDER_NAME,
 *     tokenEndpoint: TOKEN_ENDPOINT,
 *     clientId: env.CLIENT_ID,
 *     clientSecret: () => env.CLIENT_SECRET,
 *   }),
 * });
 *
 * export default http;
 * ```
 */
export function buildCallbackRouter<Request extends ClaimedRequest>(options: {
  /**
   * The methods this component's provider may deliver the callback with.
   * Defaults to `["GET"]`.
   */
  methods?: readonly CallbackMethod[];
  /** Claim the flow by state hash, in this component's own tables. */
  claim: (ctx: ActionCtx, stateHash: string) => Promise<ClaimResult<Request>>;
  /** Store the minted ticket in this component's own tables. */
  mintTicket: (
    ctx: ActionCtx,
    request: Request,
    ticket: MintedTicket,
  ) => Promise<null>;
  /** The endpoints and credentials for this flow's provider. */
  exchangeConfig: (request: Request) => ExchangeConfig;
  /**
   * Read and sanitize provider data that arrived in the callback request
   * itself rather than through a token, such as Apple's `user` field. The
   * browser relayed it, so it is user-controlled.
   */
  sanitizeParams?: (
    fields: URLSearchParams,
  ) => Record<string, unknown> | undefined;
  /**
   * This provider's own error codes for a user who declined, on top of the
   * standard `access_denied` that is always handled.
   */
  extraDeniedErrorCodes?: string[];
}): HttpRouter {
  const handler = httpActionGeneric(async (ctx, request) => {
    const url = new URL(request.url);
    // A provider that posts should set an expected content-type.
    if (
      request.method === "POST" &&
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/x-www-form-urlencoded")
    ) {
      return invalidCallbackResponse(
        url.pathname,
        "a posted callback must be a form submission",
      );
    }
    const fields =
      request.method === "POST"
        ? new URLSearchParams(await request.text())
        : url.searchParams;
    // Duplicate params aren't expected, return 400 if it happens.
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const key of fields.keys()) {
      if (seen.has(key)) {
        duplicated.add(key);
      }
      seen.add(key);
    }
    if (duplicated.size > 0) {
      return invalidCallbackResponse(
        url.pathname,
        `these parameters arrived more than once: ${JSON.stringify([...duplicated])}`,
      );
    }
    const params: CallbackRequestParams = {
      state: fields.get("state"),
      code: fields.get("code"),
      error: fields.get("error"),
      errorDescription: fields.get("error_description"),
    };
    return await runCallback<Request>({
      path: url.pathname,
      params,
      claim: (stateHash) => options.claim(ctx, stateHash),
      mintTicket: (authRequest, ticket) =>
        options.mintTicket(ctx, authRequest, ticket),
      exchangeConfig: options.exchangeConfig,
      callbackParams: options.sanitizeParams?.(fields),
      extraDeniedErrorCodes: options.extraDeniedErrorCodes,
      redirectStatus: request.method === "POST" ? 303 : 302,
    });
  });

  const http = httpRouter();
  for (const method of options.methods ?? ["GET"]) {
    http.route({ path: CALLBACK_PATH, method, handler });
  }
  return http;
}
