import { v, type Infer } from "convex/values";

// App IDs stay opaque at this boundary. defineAuthProvider preserves the app's
// users-table and provider-profile checks before references cross it.
const provider = v.object({
  name: v.string(),
  accountId: v.string(),
  profile: v.any(),
});

export const vProviderConfiguration = v.object({
  name: v.string(),
  createUser: v.function({
    fnType: "mutation",
    args: { provider },
    returns: v.string(),
  }),
  onSignIn: v.optional(
    v.function({
      fnType: "mutation",
      args: { provider, userId: v.string() },
      returns: v.null(),
    }),
  ),
});

export const authConfiguration = {
  providers: v.optional(v.array(vProviderConfiguration)),
  accessTokenTtlSeconds: v.optional(v.number()),
  refreshTokenTtlSeconds: v.optional(v.number()),
};

export type ProviderConfiguration = Infer<typeof vProviderConfiguration>;
