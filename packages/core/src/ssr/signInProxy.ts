/**
 * The SSR auth proxy: a `(Request) => Response` handler that speaks the same
 * HTTP interface as `ConvexHttpClient` and forwards calls to the deployment.
 *
 * This is what lets a method ship *one* client hook instead of a direct one
 * plus an SSR mirror. The browser holds a `ConvexHttpClient` aimed at this
 * handler rather than at the deployment, so the sign-in call of a method looks
 * identical in both session models. The only thing this handler understands is
 * the cookie half of the exchange: a minted refresh token must land in an
 * httpOnly cookie and must never reach the response body.
 *
 * The request body is forwarded essentially verbatim, which is the point. Args
 * stay in Convex's own encoding, so `Id`s, `Int64`s and bytes survive, and a
 * `ConvexError`'s `errorData` propagates back to the client to be rethrown as
 * the real thing. None of that survives a hand-rolled JSON contract.
 *
 * Only allowlisted functions are reachable.
 *
 * Refresh and sign-out deliberately do *not* go through here. They have no
 * method-specific input to unify, and the refresh token is carried in an
 * `httpOnly` cookie for SSR (not passed as an argument).
 *
 * @module
 */

import {
  getFunctionName,
  type DefaultFunctionArgs,
  type FunctionReference,
} from "convex/server";
import {
  makeSlimBundle,
  type SignInEnvelope,
  type SignInStatus,
  type TokenBundle,
} from "../lib/types.ts";
import type { AuthCookieOptions } from "./cookies.ts";
import { writeAuthCookies } from "./cookies.ts";
import type { RequestHandler } from "./handlers.ts";
import { httpCookies } from "./httpCookies.ts";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin.ts";

/**
 * A sign-in function exposed through the proxy.
 *
 * Any public mutation or action returning the shared {@link SignInEnvelope}.
 * Args are typed loosely because the proxy never inspects them; it forwards the
 * caller's encoded args untouched.
 */
export type ExposedSignInFn = FunctionReference<
  "mutation" | "action",
  "public",
  DefaultFunctionArgs,
  SignInEnvelope
>;

/** Configuration for {@link convexProxyHandler}. */
export interface ConvexProxyConfig {
  /** The Convex deployment URL to forward to. */
  convexUrl: string;
  /**
   * The sign-in functions reachable through the proxy. Anything not listed here
   * is refused, so this allowlist is the proxy's entire API surface.
   */
  signIn: ExposedSignInFn[];
  /** Auth cookie attributes; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by the CSRF origin check.
   * See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
}

/**
 * The `ConvexHttpClient` endpoints the proxy serves. The client's address ends
 * in `?path=`, so the endpoint it appends arrives as a query parameter
 * (`/auth/signin?path=/api/mutation`) and the handler mounts at a static route.
 *
 * `query_ts`/`query_at_ts` are deliberately absent: consistent-timestamp reads
 * have nothing to do with auth.
 */
const UDF_KINDS = ["query", "mutation", "action"] as const;
type UdfKind = (typeof UDF_KINDS)[number];

/**
 * The status a Convex deployment uses for "the function ran and threw". Not
 * exported by `convex/browser`, so it is duplicated here; `proxy.test.ts` pins
 * the wire contract this depends on.
 */
const UDF_FAILED_STATUS = 560;

function udfKindOf(url: URL): UdfKind | null {
  const path = url.searchParams.get("path");
  if (path === null) return null;
  return UDF_KINDS.find((kind) => path === `/api/${kind}`) ?? null;
}

/** The envelope `ConvexHttpClient` posts for a function call. */
interface CallEnvelope {
  path: string;
  format: string;
  args: unknown[];
}

function parseEnvelope(body: unknown): CallEnvelope | null {
  if (typeof body !== "object" || body === null) return null;
  const { path, format, args } = body as Record<string, unknown>;
  if (typeof path !== "string") return null;
  // The proxy forwards args untouched, so it only serves the encoding it knows
  // the shape of. Anything else is refused rather than guessed at.
  if (format !== "convex_encoded_json") return null;
  if (!Array.isArray(args) || args.length !== 1) return null;
  return { path, format, args };
}

/**
 * Whether an encoded value is a {@link TokenBundle}.
 *
 * Checked against the *encoded* JSON rather than a decoded Convex value, which
 * is sound because a bundle is only `v.string()`s and `v.number()`s: both encode
 * to their plain JSON counterparts, so the encoded and decoded forms coincide.
 * (An `Int64` or bytes field would not, and this check would need to decode.)
 */
function isEncodedTokenBundle(value: unknown): value is TokenBundle {
  if (typeof value !== "object" || value === null) return false;
  const bundle = value as Record<string, unknown>;
  return (
    typeof bundle.accessToken === "string" &&
    typeof bundle.refreshToken === "string" &&
    typeof bundle.refreshTokenExpiresAt === "number" &&
    typeof bundle.userId === "string"
  );
}

/**
 * Classify a sign-in function's return value: which arm of the envelope it is,
 * and whether it carries a bundle whose refresh token has to move into the
 * cookie.
 */
function classifyResult(
  value: unknown,
): { kind: "mint"; tokens: TokenBundle } | { kind: "forward" } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  // `status` is asserted rather than checked so the `default` arm can assert
  // exhaustiveness; that arm is also what catches a value whose status is
  // nothing of the sort.
  const { status, tokens } = value as { status: SignInStatus; tokens: unknown };
  switch (status) {
    case "complete":
      // A complete sign-in that should include a token bundle.
      return isEncodedTokenBundle(tokens) ? { kind: "mint", tokens } : null;
    case "error":
      // A sign-in error that should be passed along (unless it mistakenly
      // carries tokens, in which case it gets erased).
      return tokens === undefined ? { kind: "forward" } : null;
    default:
      status satisfies never;
      return null;
  }
}

/** A plain-text error. `ConvexHttpClient` throws its body as an `Error`. */
function textError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Build the route that serves every allowlisted sign-in function.
 *
 * Mount it once, at a static path of your choosing. Adding an auth method means
 * adding its function to {@link ConvexProxyConfig.signIn}, not adding another
 * route.
 *
 * ```ts
 * // app/auth/signin/route.ts
 * import { auth } from "@/auth"; // the result of `setupConvexAuthServer`
 *
 * export const POST = auth.convexProxyHandler;
 * ```
 */
export function convexProxyHandler(config: ConvexProxyConfig): RequestHandler {
  const allowed = new Set(config.signIn.map((fn) => getFunctionName(fn)));

  return async (request) => {
    // The CSRF guard, before anything is read off the request: a cross-site
    // sign-in would store the minted session in the victim's browser (login
    // CSRF), so it is refused up front.
    if (!isTrustedOrigin(request, config.allowedOrigins)) {
      return forbiddenOriginResponse();
    }

    const kind = udfKindOf(new URL(request.url));
    if (kind === null) return textError(404, "Not an auth proxy endpoint.");

    let envelope: CallEnvelope | null;
    try {
      envelope = parseEnvelope(await request.json());
    } catch {
      envelope = null;
    }
    if (envelope === null) {
      return textError(400, "Malformed Convex function call.");
    }
    if (!allowed.has(envelope.path)) {
      return textError(
        403,
        `${envelope.path} is not exposed through the auth proxy.`,
      );
    }

    const upstream = await fetch(`${config.convexUrl}/api/${kind}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Forwarded for deployment-side telemetry only.
        ...(request.headers.get("convex-client") !== null && {
          "convex-client": request.headers.get("convex-client")!,
        }),
        // The caller's own access token, which the backend verifies. Forwarding
        // it is strictly safer than minting one here, and it means a sign-in
        // function can still see the current identity (e.g. to link accounts).
        ...(request.headers.get("authorization") !== null && {
          authorization: request.headers.get("authorization")!,
        }),
      },
      // Re-serialized from the parsed envelope so only the three known fields
      // reach the deployment, but `args` itself is the caller's encoding,
      // untouched.
      body: JSON.stringify({
        path: envelope.path,
        format: "convex_encoded_json",
        args: envelope.args,
      }),
    });

    // A status outside the function-result protocol (200 = ran, 560 = the
    // function threw) is not a function result at all, so forward it as the
    // transport-level failure it is.
    if (!upstream.ok && upstream.status !== UDF_FAILED_STATUS) {
      return textError(upstream.status, await upstream.text());
    }

    // Everything except the minted refresh token is forwarded as-is.
    const payload = (await upstream.json()) as Record<string, unknown>;

    if (payload.status !== "success") {
      // A thrown function: `errorMessage`/`errorData` pass through so the client
      // rethrows a real `ConvexError`. These are public functions, so this is
      // already what a direct caller sees.
      return Response.json(payload, { status: upstream.status });
    }

    const result = classifyResult(payload.value);
    if (result === null) {
      // Fail closed. An allowlisted sign-in function that doesn't return the
      // shared envelope is a wiring bug, and forwarding an unrecognized value is
      // how a refresh token would reach browser JS.
      return textError(
        500,
        `${envelope.path} did not return a sign-in result. The sign-in ` +
          `functions must return the shared envelope ` +
          `({ status: "complete", tokens } or { status: "error", userError }).`,
      );
    }

    if (result.kind === "forward") {
      return Response.json(payload, { status: upstream.status });
    }

    const cookies = httpCookies(request);
    await writeAuthCookies(cookies, result.tokens, config.cookieOptions);
    // The refresh token goes to the cookie and gets removed from the tokens.
    (payload.value as Record<string, unknown>).tokens = makeSlimBundle(
      result.tokens,
    );

    const response = Response.json(payload, { status: upstream.status });
    cookies.applyTo(response.headers);
    return response;
  };
}
