import { anyApi, type FunctionReference } from "convex/server";
import { v, type GenericId } from "convex/values";
import { describe, expect, test } from "vitest";
import { defineAuthProvider } from "./configuration.ts";

type Provider = {
  name: "custom";
  accountId: string;
  profile: { email: string };
};
const createUser = anyApi.users.createUser as FunctionReference<
  "mutation",
  "internal",
  { provider: Provider },
  GenericId<"users">
>;
const onSignIn = anyApi.users.onSignIn as FunctionReference<
  "mutation",
  "internal",
  { provider: Provider; userId: GenericId<"users"> },
  null
>;
const createMember = anyApi.users.createMember as FunctionReference<
  "mutation",
  "internal",
  { provider: Provider },
  GenericId<"members">
>;
const incompatibleProfile = anyApi.users.wrongProfile as FunctionReference<
  "mutation",
  "internal",
  { provider: Omit<Provider, "profile"> & { profile: { email: number } } },
  GenericId<"users">
>;
const incompatibleSignIn = anyApi.users.wrongSignIn as FunctionReference<
  "mutation",
  "internal",
  { provider: Provider; userId: GenericId<"orders"> },
  null
>;

describe("provider configuration typing", () => {
  test("keeps app ID callbacks typed while returning installation references", () => {
    const configuration = defineAuthProvider({
      name: "custom",
      profile: v.object({ email: v.string() }),
      createUser,
      onSignIn,
    });
    expect(configuration).toEqual({ name: "custom", createUser, onSignIn });
    defineAuthProvider({
      name: "custom",
      profile: v.object({ email: v.string() }),
      usersTable: "members",
      createUser: createMember,
    });
  });
});

// Compiler checks protect the guarantees lost by using string IDs and v.any()
// directly in a component's installation contract.
void (() => {
  defineAuthProvider({
    name: "custom",
    profile: v.object({ email: v.string() }),
    // @ts-expect-error Default app table is users, not members.
    createUser: createMember,
  });
  defineAuthProvider({
    name: "custom",
    profile: v.object({ email: v.string() }),
    // @ts-expect-error Callback cannot require a different profile shape.
    createUser: incompatibleProfile,
  });
  defineAuthProvider({
    name: "custom",
    profile: v.object({ email: v.string() }),
    createUser,
    // @ts-expect-error Sign-in callback cannot require IDs from orders.
    onSignIn: incompatibleSignIn,
  });
});
