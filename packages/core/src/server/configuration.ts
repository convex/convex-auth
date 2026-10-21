import type { ComponentArgInput } from "convex/server";
import type { Validator } from "convex/values";
import type { ProviderConfiguration } from "../lib/configuration.ts";
import type { UserCallbacks } from "../lib/types.ts";

// Infer configuration from name/profile/usersTable, not from the callbacks.
type NoCallbackInference<T> = [T][T extends unknown ? 0 : never];

/**
 * Register app callbacks in `app.use(auth, { args: { providers: [...] } })`.
 *
 * `profile` checks callback compatibility without serializing a validator as
 * configuration. `usersTable` defaults to `users`; specify it for another app
 * table. App mutations keep their own `v.id(usersTable)` validators.
 */
export function defineAuthProvider<
  const Name extends string,
  Profile,
  const UsersTable extends string = "users",
>(
  options: {
    name: Name;
    profile: Validator<Profile, "required", string>;
    usersTable?: UsersTable;
  } & UserCallbacks<
    NoCallbackInference<Name>,
    NoCallbackInference<Profile>,
    NoCallbackInference<UsersTable>
  >,
): ComponentArgInput<ProviderConfiguration> {
  const { name, createUser, onSignIn } = options;
  // The core remembers app IDs as strings, then sends back the same IDs.
  // Keep this namespace bridge inside Auth rather than widening app callbacks.
  return {
    name,
    createUser,
    onSignIn,
  } as unknown as ComponentArgInput<ProviderConfiguration>;
}
