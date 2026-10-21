import {
  anyApi,
  defineComponent,
  internalMutationGeneric,
  type ApiFromModules,
} from "convex/server";
import { v } from "convex/values";

export const provider = v.object({
  name: v.literal("password"),
  accountId: v.string(),
  profile: v.object({}),
});

export const createUser = v.function({
  fnType: "mutation",
  args: { provider },
  returns: v.string(),
});

export const onSignIn = v.function({
  fnType: "mutation",
  args: { provider, userId: v.string() },
  returns: v.null(),
});

// Only exercise the JS contract. This mutation is never deployed or run.
const _configure = internalMutationGeneric({
  args: {
    providers: v.array(
      v.object({
        name: v.string(),
        createUser,
        onSignIn: v.optional(onSignIn),
      }),
    ),
    accessTokenTtlSeconds: v.optional(v.number()),
  },
  handler: async (_ctx, _args) => null,
});

type InitReference = ApiFromModules<{
  init: { configure: typeof _configure };
}>["init"]["configure"];

export const auth = defineComponent("auth", {
  init: anyApi.init.configure as InitReference,
});
