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
import { componentsGeneric, createFunctionHandle } from "convex/server";
import type {
  FunctionReference,
  GenericSchema,
  SchemaDefinition,
} from "convex/server";
import type { ProviderConfiguration } from "../lib/configuration.ts";
import type { ComponentApi } from "../component/_generated/component.ts";
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

/** Apply installation settings when convex-test does not run component init. */
export async function configureCore(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  options: {
    providers: Array<{
      name: string;
      createUser: FunctionReference<"mutation", "public" | "internal">;
      onSignIn?: FunctionReference<"mutation", "public" | "internal">;
    }>;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
  },
  name: string = "auth",
) {
  const component = (
    componentsGeneric() as unknown as Record<string, ComponentApi>
  )[name];
  await t.run(async (ctx) => {
    const providers = await Promise.all(
      options.providers.map(async (provider) => ({
        name: provider.name,
        createUser: (await createFunctionHandle(
          provider.createUser,
        )) as ProviderConfiguration["createUser"],
        onSignIn:
          provider.onSignIn === undefined
            ? undefined
            : ((await createFunctionHandle(
                provider.onSignIn,
              )) as ProviderConfiguration["onSignIn"]),
      })),
    );
    await ctx.runMutation(component.init.configure, { ...options, providers });
  });
}

export default { registerCore, configureCore, schema, modules };
