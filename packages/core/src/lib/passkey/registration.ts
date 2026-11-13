/**
 * Adding a passkey to an account that exists: the limit of passkeys per
 * user, and the registration ceremony. Both passkey methods use them, once
 * they have verified the user their own way.
 *
 * @module
 */
import type { GenericDataModel, GenericMutationCtx } from "convex/server";
import { Infer, v } from "convex/values";
import {
  finishRegistrationUserError,
  vRegistrationResponseJSON,
} from "../../components/passkey/validation.ts";
import { defaultPasskeyName } from "./aaguids.ts";
import type { PasskeyConfig } from "./config.ts";
import { buildRegistrationOptions } from "./options.ts";

/**
 * The largest number of passkeys that one user can hold.
 *
 * Each passkey of the user goes into the `allowCredentials` list of every
 * sign-in and into the `excludeCredentials` list of every registration, thus
 * an unbounded list grows the payload of every ceremony. The limit is far
 * above the number of authenticators that a person uses, and the user can
 * remove a passkey to make room for a new one.
 *
 * The component stays permissive; the method makes the policy, like it does
 * for the removal of the last passkey.
 */
export const MAX_PASSKEYS_PER_USER = 20;

/**
 * The user-facing error when the user already holds the largest number of
 * passkeys.
 */
export const tooManyPasskeysUserError = v.object({
  error: v.literal("TOO_MANY_PASSKEYS"),
});

/**
 * The result of {@link finishPasskeyRegistration}.
 *
 * @internal
 */
export type FinishPasskeyRegistrationResult =
  | { success: true; passkeyId: string }
  | {
      success: false;
      userError:
        | Infer<typeof finishRegistrationUserError>
        | Infer<typeof tooManyPasskeysUserError>;
    };

/**
 * What the registration helpers below need from a passkey method.
 *
 * @internal
 */
export type PasskeyRegistrationConfig = Pick<
  PasskeyConfig,
  "component" | "rpId" | "rpName" | "origin"
>;

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/**
 * Whether `userId` already holds the largest number of passkeys.
 *
 * @internal
 */
export async function hasTooManyPasskeys(
  ctx: MutationCtx,
  config: Pick<PasskeyRegistrationConfig, "component">,
  userId: string,
): Promise<boolean> {
  const passkeys = await ctx.runQuery(
    config.component.registration.listPasskeys,
    { userId },
  );
  return passkeys.length >= MAX_PASSKEYS_PER_USER;
}

/**
 * Start the registration of a new passkey for `userId`, whom the caller has
 * verified, and build the options of the `create()` call.
 *
 * `user` is what the browser shows for the new passkey in its passkey
 * manager.
 *
 * @internal
 */
export async function startPasskeyRegistration(
  ctx: MutationCtx,
  config: PasskeyRegistrationConfig,
  userId: string,
  user: { name: string; displayName: string },
) {
  const { challenge, userHandle, excludeCredentials } = await ctx.runMutation(
    config.component.registration.startRegistrationForExistingUser,
    { verifiedUserId: userId },
  );
  return buildRegistrationOptions({
    rpId: config.rpId,
    rpName: config.rpName,
    challenge,
    userHandle,
    userName: user.name,
    userDisplayName: user.displayName,
    excludeCredentials,
  });
}

/**
 * Verify the `create()` response of a registration that
 * {@link startPasskeyRegistration} started for `userId`, and store the new
 * passkey.
 *
 * @internal
 */
export async function finishPasskeyRegistration(
  ctx: MutationCtx,
  config: PasskeyRegistrationConfig,
  userId: string,
  response: Infer<typeof vRegistrationResponseJSON>,
): Promise<FinishPasskeyRegistrationResult> {
  if (await hasTooManyPasskeys(ctx, config, userId)) {
    return { success: false, userError: { error: "TOO_MANY_PASSKEYS" } };
  }

  const registrationResult = await ctx.runMutation(
    config.component.registration
      ._internal_dangerous_finishRegistrationForExistingUser,
    {
      expectedRpId: config.rpId,
      expectedOrigin: config.origin,
      verifiedUserId: userId,
      response,
      // The app does not name a new passkey yet, thus the method names
      // it after the authenticator model.
      // TODO(nicolas) Allow the user to provide a custom name when creating a passkey
      name: defaultPasskeyName(response),
    },
  );
  if (!registrationResult.success) {
    const { userError } = registrationResult;
    if (userError.error === "INVALID_NAME") {
      // Not possible: the only name that this function passes is a
      // default name, and every default name is a short label that the
      // component stores.
      throw new Error(
        "Unexpected error when storing the passkey: INVALID_NAME",
        { cause: userError },
      );
    }
    // A `PROTOCOL_ERROR` here also covers a registration ceremony that
    // belongs to a different user than the caller, which happens when the
    // caller signs in as a different user after the registration started.
    // `_internal_dangerous_finishRegistrationForExistingUser` compares the
    // owner of the ceremony with `verifiedUserId`, thus the callers need no
    // check of their own.
    return { success: false, userError };
  }
  return { success: true, passkeyId: registrationResult.passkeyId };
}
