/**
 * Adding and removing a passkey of a signed-in user.
 *
 * The user must have authenticated recently, with any method: a sign-in, or
 * a re-authentication with a passkey. An email-only user thus adds their
 * first passkey right after a sign-in. Both finishing mutations check it
 * again, so a ceremony started in time cannot finish after the time is up.
 *
 * ```
 *  Client                             Method
 *    │                                   │
 *    │  startAddPasskey()                │
 *    ├──────────────────────────────────▶│  check the authentication time,
 *    │◀──────────────────────────────────┤  start the registration
 *    │                                   │
 *    ├─▶ navigator.credentials.create()  │
 *    │                                   │
 *    │  finishAddPasskey(attestation)    │
 *    ├──────────────────────────────────▶│  check it again, store the passkey
 *    │◀──────────────────────────────────┤
 *    │                                   │
 * ```
 *
 * @module
 */
import {
  mutationGeneric,
  type FunctionReference_future,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { Infer, v, type GenericId } from "convex/values";
import { checkRecentAuthentication } from "../../server/reauthentication.ts";
import type { ComponentApi } from "../../components/passkey/_generated/component.ts";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import {
  deletePasskeyUserError,
  finishRegistrationUserError,
  notLoggedInUserError,
  vPublicKeyCredentialCreationOptionsJSON,
  vRegistrationResponseJSON,
  type ExpectedOrigin,
} from "../../components/passkey/validation.ts";
import {
  finishPasskeyRegistration,
  hasTooManyPasskeys,
  startPasskeyRegistration,
  tooManyPasskeysUserError,
} from "../../lib/passkey/registration.ts";

/**
 * The names that the browser shows for a new passkey in its passkey manager.
 * See {@link GetUserNameFn}.
 */
export type PasskeyUserName = {
  /** The account name, for example an email address. */
  name: string;
  /** The name of the person, for example "Ada Lovelace". */
  displayName: string;
};

/**
 * The app's query that names a user for a new passkey. The method calls it
 * when the user adds a passkey.
 *
 * WebAuthn requires both names, and the browser keeps them for the life of
 * the passkey. Throw when the user has no name to give, for example when the
 * user has no email address.
 */
export type GetUserNameFn<UsersTable extends string = string> =
  FunctionReference_future<
    "query",
    "internal",
    { userId: GenericId<UsersTable> },
    PasskeyUserName
  >;

/**
 * What the management functions close over.
 *
 * @internal
 */
export type PasskeyManagementConfig = {
  component: ComponentApi;
  coreComponent: CoreComponentApi;
  rpId: string;
  rpName: string;
  origin: ExpectedOrigin;
  maxAuthenticationAgeSeconds: number;
  getUserName: GetUserNameFn;
};

/**
 * The user-facing error when the user did not authenticate recently enough
 * to change their passkeys. Re-authenticate, then try again.
 */
const reauthenticationRequiredUserError = v.object({
  error: v.literal("REAUTHENTICATION_REQUIRED"),
});

const startAddPasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    // Ready for the `navigator.credentials.create()` call.
    options: vPublicKeyCredentialCreationOptionsJSON,
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notLoggedInUserError,
      reauthenticationRequiredUserError,
      tooManyPasskeysUserError,
    ),
  }),
);

/** The result of `startAddPasskey`. */
export type StartAddPasskeyResult = Infer<typeof startAddPasskeyResult>;

const finishAddPasskeyResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notLoggedInUserError,
      reauthenticationRequiredUserError,
      finishRegistrationUserError,
      tooManyPasskeysUserError,
    ),
  }),
);

/** The result of `finishAddPasskey`. */
export type FinishAddPasskeyResult = Infer<typeof finishAddPasskeyResult>;

const removePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notLoggedInUserError,
      reauthenticationRequiredUserError,
      deletePasskeyUserError,
    ),
  }),
);

/** The result of `removePasskey`. */
export type RemovePasskeyResult = Infer<typeof removePasskeyResult>;

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/** The signed-in user, when they authenticated recently enough. */
async function recentlyAuthenticatedUser(
  ctx: MutationCtx,
  config: PasskeyManagementConfig,
) {
  return await checkRecentAuthentication(ctx, {
    component: config.coreComponent,
    maxAgeSeconds: config.maxAuthenticationAgeSeconds,
  });
}

/** @internal */
export function startAddPasskey(config: PasskeyManagementConfig) {
  return mutationGeneric({
    args: {},
    returns: startAddPasskeyResult,
    handler: async (ctx): Promise<StartAddPasskeyResult> => {
      const caller = await recentlyAuthenticatedUser(ctx, config);
      if (!caller.success) {
        return { success: false, userError: { error: caller.error } };
      }
      const { userId } = caller;
      if (await hasTooManyPasskeys(ctx, config, userId)) {
        return { success: false, userError: { error: "TOO_MANY_PASSKEYS" } };
      }
      // The core keeps the user id as a plain string; the app's query takes
      // it as an id of its users table.
      const user = await ctx.runQuery(config.getUserName, {
        userId: userId as GenericId<string>,
      });
      if (
        typeof user?.name !== "string" ||
        user.name === "" ||
        typeof user.displayName !== "string" ||
        user.displayName === ""
      ) {
        throw new Error(
          "The `getUserName` query of the passkey method must return a " +
            "non-empty `name` and `displayName`.",
        );
      }
      return {
        success: true,
        options: await startPasskeyRegistration(ctx, config, userId, user),
      };
    },
  });
}

/** @internal */
export function finishAddPasskey(config: PasskeyManagementConfig) {
  return mutationGeneric({
    args: { response: vRegistrationResponseJSON },
    returns: finishAddPasskeyResult,
    handler: async (ctx, args): Promise<FinishAddPasskeyResult> => {
      const caller = await recentlyAuthenticatedUser(ctx, config);
      if (!caller.success) {
        return { success: false, userError: { error: caller.error } };
      }
      return await finishPasskeyRegistration(
        ctx,
        config,
        caller.userId,
        args.response,
      );
    },
  });
}

/** @internal */
export function removePasskey(config: PasskeyManagementConfig) {
  return mutationGeneric({
    args: { passkeyId: v.string() },
    returns: removePasskeyResult,
    handler: async (ctx, { passkeyId }): Promise<RemovePasskeyResult> => {
      const caller = await recentlyAuthenticatedUser(ctx, config);
      if (!caller.success) {
        return { success: false, userError: { error: caller.error } };
      }
      // The component checks that the passkey belongs to the user. The last
      // passkey can go too: this method never makes a user, thus the user
      // has another way to sign in.
      return await ctx.runMutation(
        config.component.registration.deletePasskey,
        {
          userId: caller.userId,
          passkeyId,
        },
      );
    },
  });
}
