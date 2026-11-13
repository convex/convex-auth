/**
 * The passkey management flows: adding and removing a passkey.
 *
 * @module
 */

import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import type {
  ResolvedPasskeyCeremonies,
  PasskeyClientFailure,
} from "../../../lib/passkey/ceremonies.ts";
import type {
  WireAuthenticationResponse,
  WireRegistrationResponse,
} from "../../../components/passkey/validation.ts";
import type {
  FinishAddPasskeyResult,
  StartAddPasskeyResult,
  VerifyAddPasskeyResult,
} from "./add.ts";
import type {
  FinishRemovePasskeyResult,
  StartRemovePasskeyResult,
} from "./remove.ts";

type StartAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAddPasskeyResult
>;

type VerifyAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireAuthenticationResponse },
  VerifyAddPasskeyResult
>;

type FinishAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireRegistrationResponse },
  FinishAddPasskeyResult
>;

type StartRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string },
  StartRemovePasskeyResult
>;

type FinishRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string; response: WireAuthenticationResponse },
  FinishRemovePasskeyResult
>;

export type AddPasskeyApi = {
  startAddPasskey: StartAddPasskeyMutation;
  verifyAddPasskey: VerifyAddPasskeyMutation;
  finishAddPasskey: FinishAddPasskeyMutation;
};

export type RemovePasskeyApi = {
  startRemovePasskey: StartRemovePasskeyMutation;
  finishRemovePasskey: FinishRemovePasskeyMutation;
};

export type ManagementFlowContext<Api> = {
  convex: ConvexReactClient;
  api: Api;
  /** The passkey ceremonies of the platform. */
  ceremonies: ResolvedPasskeyCeremonies;
};

export type AddPasskeyFlowResult =
  | FinishAddPasskeyResult
  | Extract<StartAddPasskeyResult, { success: false }>
  | Extract<VerifyAddPasskeyResult, { success: false }>
  | PasskeyClientFailure;

export type RemovePasskeyFlowResult =
  | FinishRemovePasskeyResult
  | Extract<StartRemovePasskeyResult, { success: false }>
  | PasskeyClientFailure;

/**
 * Adds a passkey to the account of the signed-in user.
 *
 * First asks the user to authenticate with an existing passkey to prove
 * their identity, then registers a new passkey.
 */
export async function runAddPasskeyFlow(
  ctx: ManagementFlowContext<AddPasskeyApi>,
): Promise<AddPasskeyFlowResult> {
  const { convex, api, ceremonies } = ctx;

  if (!ceremonies.isSupported()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await convex.mutation(api.startAddPasskey, {});
  if (!start.success) {
    return start;
  }
  const assertion = await ceremonies.authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  const verified = await convex.mutation(api.verifyAddPasskey, {
    response: assertion.response,
  });
  if (!verified.success) {
    return verified;
  }
  const registration = await ceremonies.register(verified.options);
  if (!registration.success) {
    return registration;
  }
  return await convex.mutation(api.finishAddPasskey, {
    response: registration.response,
  });
}

/**
 * Removes a passkey from the account of the signed-in user.
 *
 * The user must authenticate with another passkey first.
 */
export async function runRemovePasskeyFlow(
  ctx: ManagementFlowContext<RemovePasskeyApi>,
  { passkeyId }: { passkeyId: string },
): Promise<RemovePasskeyFlowResult> {
  const { convex, api, ceremonies } = ctx;

  if (!ceremonies.isSupported()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await convex.mutation(api.startRemovePasskey, { passkeyId });
  if (!start.success) {
    return start;
  }
  const assertion = await ceremonies.authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  return await convex.mutation(api.finishRemovePasskey, {
    passkeyId,
    response: assertion.response,
  });
}
