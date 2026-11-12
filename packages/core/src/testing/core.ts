/// <reference types="vite/client" />
// This helper ships as TypeScript, not as part of the compiled build: the
// `import.meta.glob` below is a Vite macro that only works if the consumer's
// bundler transforms this file. Vitest externalizes plain `.js` under
// `node_modules` and would leave the macro untransformed, but it can't
// externalize `.ts`, so shipping source is what makes this work at all.
// The schema import below uses the extension of the file on disk. The
// TypeScript compiler of the consumer reads this file, thus the consumer must
// set `allowImportingTsExtensions`. If it is not set, TypeScript gives the
// error TS5097.
import type { TestConvex } from "convex-test";
import { decodeJwt } from "jose";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "../component/schema.ts";
const modules = import.meta.glob([
  "../component/**/*.ts",
  "!../component/**/*.fixture.ts",
]);

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerCore(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "auth",
) {
  t.registerComponent(name, schema, modules);
}
/**
 * The identity Convex derives from the access token of a sign-in, for
 * `t.withIdentity`: its subject (the session id) and its issuer (the core).
 * The core looks the user up through the session, so a test signs in for real
 * and calls as that session:
 *
 * ```ts
 * const result = await t.mutation(api.auth.signUpWithUsernamePassword, {
 *   username: "alice",
 *   password: "correct horse battery staple",
 * });
 * if (result.status !== "complete") throw new Error("sign-up failed");
 * const alice = t.withIdentity(sessionIdentity(result.tokens));
 * ```
 */
export function sessionIdentity(tokens: { accessToken: string }): {
  subject: string;
  issuer: string;
} {
  const { sub, iss } = decodeJwt(tokens.accessToken);
  if (typeof sub !== "string" || typeof iss !== "string") {
    throw new Error("The access token has no subject or no issuer.");
  }
  // The core attests the signed-in user only for an identity that it issued.
  return { subject: sub, issuer: iss };
}

/**
 * Authenticate the calls of `t` with the real access token of a session, as a
 * client that signed in does:
 *
 * ```ts
 * const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
 * const alice = withSession(t, tokens);
 * ```
 *
 * The core's `attestCurrentUser` verifies the signature of the access token
 * itself. `t.withIdentity(sessionIdentity(tokens))` sends a token that
 * convex-test does not sign, thus the functions that need the signed-in user
 * (for example `completeChangeEmail`) need this helper.
 *
 * Requires a version of convex-test with `withAuthToken`.
 */
export function withSession<T>(t: T, tokens: { accessToken: string }): T {
  const withAuthToken = (t as { withAuthToken?: (token: string) => T })
    .withAuthToken;
  if (typeof withAuthToken !== "function") {
    throw new Error(
      "This version of convex-test cannot authenticate a call with a real " +
        "access token (`withAuthToken`).",
    );
  }
  return withAuthToken.call(t, tokens.accessToken);
}

export default {
  registerCore,
  sessionIdentity,
  withSession,
  schema,
  modules,
};
