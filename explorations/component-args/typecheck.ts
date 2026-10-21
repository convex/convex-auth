import {
  anyApi,
  defineApp,
  defineComponent,
  type FunctionHandle_future,
  type FunctionReference,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { v, type GenericId, type Infer } from "convex/values";
import { auth, provider } from "./contracts.ts";

type Provider = Infer<typeof provider>;
declare const createUser: FunctionReference<
  "mutation",
  "internal",
  { provider: Provider },
  GenericId<"users">
>;
declare const onSignIn: FunctionReference<
  "mutation",
  "internal",
  { provider: Provider; userId: GenericId<"users"> },
  null
>;
declare const requiresExtraArgument: FunctionReference<
  "mutation",
  "internal",
  { provider: Provider; required: string },
  string
>;
declare const queryInsteadOfMutation: FunctionReference<
  "query",
  "internal",
  { provider: Provider },
  string
>;
declare const returnsWrongType: FunctionReference<
  "mutation",
  "internal",
  { provider: Provider },
  number
>;
declare const returnsWrongTable: FunctionReference<
  "mutation",
  "internal",
  { provider: Provider },
  GenericId<"orders">
>;

// Compile only: function references normally come from codegen. The expected
// errors make SDK changes to these compatibility findings visible to tsc.
void (() => {
  const app = defineApp();
  app.use(auth, {
    args: { providers: [{ name: "password", createUser }] },
  });
  app.use(auth, {
    args: {
      providers: [
        {
          name: "password",
          createUser,
          // @ts-expect-error A string contract cannot promise an app Id.
          onSignIn,
        },
      ],
    },
  });
  app.use(auth, {
    args: {
      providers: [
        {
          name: "password",
          // @ts-expect-error The component will not supply `required`.
          createUser: requiresExtraArgument,
        },
      ],
    },
  });
  app.use(auth, {
    args: {
      providers: [
        {
          name: "password",
          // @ts-expect-error A query does not satisfy a mutation contract.
          createUser: queryInsteadOfMutation,
        },
      ],
    },
  });
  app.use(auth, {
    args: {
      providers: [
        {
          name: "password",
          // @ts-expect-error A number does not satisfy a string return contract.
          createUser: returnsWrongType,
        },
      ],
    },
  });
  // Accepted: a string return contract loses the users-table check.
  app.use(auth, {
    args: {
      providers: [{ name: "password", createUser: returnsWrongTable }],
    },
  });
});

const _broadCallback = v.function({
  fnType: "mutation",
  args: { profile: v.any() },
  returns: v.string(),
});
const broadAuth = defineComponent("broadAuth", {
  init: anyApi.init.configure as FunctionReference<
    "mutation",
    "internal",
    { callback: Infer<typeof _broadCallback> },
    null
  >,
});
declare const narrowProfileCallback: FunctionReference<
  "mutation",
  "internal",
  { profile: { email: string } },
  string
>;
void (() => {
  // Accepted: v.any() does not check the provider's actual profile shape.
  defineApp().use(broadAuth, { args: { callback: narrowProfileCallback } });
});

declare const ctx: GenericMutationCtx<GenericDataModel>;
declare const handle: FunctionHandle_future<
  "mutation",
  { provider: Provider },
  string
>;
void (() =>
  ctx.runMutation(handle, {
    provider: { name: "password", accountId: "", profile: {} },
  }));
