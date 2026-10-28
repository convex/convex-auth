/**
 * The types of the calls that the auth client makes, and helpers that read a
 * Convex client.
 *
 * The Convex imports are type-only, so the auth client works with any Convex
 * client class.
 *
 * @module
 */
import type { ConvexHttpClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type { ClientView, SignInEnvelope } from "../lib/types.ts";

/**
 * A public function returning the shared `SignInEnvelope`, as the client sees
 * it. The requirement is on `_returnType` alone, leaving the args as Convex
 * declares them so its clients still infer optional args.
 */
export type SignInFunction<Type extends "mutation" | "action"> =
  FunctionReference<Type, "public"> & {
    _returnType: ClientView<SignInEnvelope>;
  };

/**
 * How a provider's sign-in functions get executed. Provider code calls it
 * through `AuthClient.signIn` and does not pick a transport itself. Executing
 * the call is the only thing that differs between the two session models, so
 * one implementation of a provider serves both:
 *
 *  - SPA: called against the deployment, returning the full `TokenBundle`
 *    for client JS to persist.
 *  - SSR: called through the auth proxy on the SSR host, returning an
 *    access-only `SlimTokenBundle` (the refresh token stays server-side).
 *
 * A provider never sees which model it is running under.
 *
 * Only functions returning the shared `SignInEnvelope` are accepted, because
 * under SSR the auth proxy refuses any other result. A function that mints no
 * session runs on `AuthClient.convex` instead.
 *
 * Sign-in functions are safe to run before authentication on any transport.
 * Callers retry them on network errors, so a sign-in function must tolerate
 * re-executing after an attempt that already committed server-side.
 */
export interface AuthSignInApi {
  mutation<F extends SignInFunction<"mutation">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
  action<F extends SignInFunction<"action">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/**
 * The calls the auth client makes on the app's Convex client. A
 * `ConvexReactClient` and a `ConvexClient` both have them.
 */
export interface ConvexClientApi {
  mutation<F extends FunctionReference<"mutation", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
  action<F extends FunctionReference<"action", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/** The `logger` option of a `ConvexHttpClient`. */
export type HttpClientLogger = NonNullable<
  ConstructorParameters<typeof ConvexHttpClient>[1]
>["logger"];

/** The deployment URL of a Convex client, or undefined when it has none. */
export function deploymentUrlOf(convex: object): string | undefined {
  return "url" in convex && typeof convex.url === "string"
    ? convex.url
    : undefined;
}

/** The logger of a Convex client, or undefined when it has none. */
export function loggerOf(convex: object): HttpClientLogger {
  if (
    "logger" in convex &&
    typeof convex.logger === "object" &&
    convex.logger !== null &&
    "log" in convex.logger &&
    typeof convex.logger.log === "function"
  ) {
    // A Convex client's logger has the other methods that the check skips.
    return convex.logger as HttpClientLogger;
  }
  return undefined;
}

/** Whether two deployment URLs match, ignoring trailing slashes. */
export function sameDeployment(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
