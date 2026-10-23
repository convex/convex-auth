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
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import schema from "../component/schema.ts";
const modules = import.meta.glob([
  "../component/**/*.ts",
  "!../component/**/*.fixture.ts",
]);

/**
 * Register the component with the test convex instance, along with the batch
 * worker it mounts (the loop that erases expired sessions).
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerCore(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "auth",
) {
  t.registerComponent(name, schema, modules);
  registerBatchWorker(t, `${name}/batchWorker`);
}
/**
 * The identity Convex derives from the access token of a sign-in, for
 * `t.withIdentity`. The token's subject is the session id, and the core looks
 * the user up through the session, so a test signs in for real and calls as
 * that session:
 *
 * ```ts
 * const { tokens } = await t.mutation(api.auth.signInAnonymously, {});
 * const alice = t.withIdentity(sessionIdentity(tokens));
 * ```
 */
export function sessionIdentity(tokens: { accessToken: string }): {
  subject: string;
} {
  const { sub } = decodeJwt(tokens.accessToken);
  if (typeof sub !== "string") {
    throw new Error("The access token has no subject.");
  }
  return { subject: sub };
}

export default { registerCore, sessionIdentity, schema, modules };
