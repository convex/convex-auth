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
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "../components/password/schema.ts";
const modules = import.meta.glob("../components/password/**/*.ts");

/**
 * Register the password component with a `convex-test` instance.
 *
 * The component throttles `verifyPassword` through a nested rate-limiter, so we
 * register that under `<name>/rateLimiter` too — mirroring how it's mounted when
 * the app `app.use`s the `convex.config` of the component.
 *
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
export function registerPassword(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "authPassword",
) {
  t.registerComponent(name, schema, modules);
  registerRateLimiter(t, `${name}/rateLimiter`);
}
export default { registerPassword, schema, modules };
