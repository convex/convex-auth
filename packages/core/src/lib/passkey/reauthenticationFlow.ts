/**
 * The client flow that re-authenticates the signed-in user with one of their
 * passkeys. Both passkey methods use it.
 *
 * @module
 */

import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import type {
  PasskeyClientFailure,
  ResolvedPasskeyCeremonies,
} from "./ceremonies.ts";
import type { WireAuthenticationResponse } from "../../components/passkey/validation.ts";
import type {
  FinishPasskeyReauthenticationResult,
  StartPasskeyReauthenticationResult,
} from "./reauthenticate.ts";

type StartPasskeyReauthenticationMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartPasskeyReauthenticationResult
>;

type FinishPasskeyReauthenticationMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireAuthenticationResponse },
  FinishPasskeyReauthenticationResult
>;

/** The re-authentication functions that both passkey methods export. */
export type PasskeyReauthenticationApi = {
  startPasskeyReauthentication: StartPasskeyReauthenticationMutation;
  finishPasskeyReauthentication: FinishPasskeyReauthenticationMutation;
};

export type PasskeyReauthenticationFlowResult =
  | FinishPasskeyReauthenticationResult
  | Extract<StartPasskeyReauthenticationResult, { success: false }>
  | PasskeyClientFailure;

/** What the re-authentication flow needs from the surrounding React tree. */
export type PasskeyReauthenticationFlowContext = {
  convex: ConvexReactClient;
  api: PasskeyReauthenticationApi;
  /** The passkey ceremonies of the platform. */
  ceremonies: ResolvedPasskeyCeremonies;
};

/**
 * Re-authenticates the signed-in user with one of their passkeys, and
 * records it on the current session.
 */
export async function runPasskeyReauthenticationFlow(
  ctx: PasskeyReauthenticationFlowContext,
): Promise<PasskeyReauthenticationFlowResult> {
  const { convex, api, ceremonies } = ctx;

  if (!ceremonies.isSupported()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await convex.mutation(api.startPasskeyReauthentication, {});
  if (!start.success) {
    return start;
  }
  const assertion = await ceremonies.authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  return await convex.mutation(api.finishPasskeyReauthentication, {
    response: assertion.response,
  });
}
