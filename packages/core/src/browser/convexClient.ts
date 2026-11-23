/**
 * The calls the auth client makes on the app's Convex client, and helpers
 * that read a Convex client.
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
