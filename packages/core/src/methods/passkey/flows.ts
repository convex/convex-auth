/**
 * The client flows of the `passkey` method: signing in from a button, and
 * adding a passkey.
 *
 * @module
 */

import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type {
  ClientView,
  SignInError,
  SlimTokenBundle,
  TokenBundle,
} from "../../lib/types.ts";
import type {
  PasskeyClientError,
  PasskeyClientFailure,
  ResolvedPasskeyCeremonies,
} from "../../lib/passkey/ceremonies.ts";
import type {
  WireAuthenticationResponse,
  WireRegistrationResponse,
} from "../../components/passkey/validation.ts";
import type {
  FinishAddPasskeyResult,
  StartAddPasskeyResult,
} from "./management.ts";
import type {
  FinishSignInWithPasskeyResult,
  StartSignInWithPasskeyResult,
} from "./server.ts";

/** The sign-in functions of the method, usually `api.passkey`. */
export type PasskeySignInApi = {
  startSignInWithPasskey: FunctionReference<
    "mutation",
    "public",
    Record<string, never>,
    StartSignInWithPasskeyResult
  >;
  finishSignInWithPasskey: FunctionReference<
    "mutation",
    "public",
    { response: WireAuthenticationResponse },
    ClientView<FinishSignInWithPasskeyResult>
  >;
};

/** The add functions of the method, usually `api.passkey`. */
export type AddPasskeyApi = {
  startAddPasskey: FunctionReference<
    "mutation",
    "public",
    Record<string, never>,
    StartAddPasskeyResult
  >;
  finishAddPasskey: FunctionReference<
    "mutation",
    "public",
    { response: WireRegistrationResponse },
    FinishAddPasskeyResult
  >;
};

/** What the sign-in flow needs from the surrounding React tree. */
export type SignInFlowContext = {
  convex: ConvexReactClient;
  api: PasskeySignInApi;
  /**
   * Runs a mutation that mints a session, under both session models (SPA
   * and SSR).
   */
  signInApi: AuthSignInApi;
  /** Stores a minted session. */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
  ceremonies: ResolvedPasskeyCeremonies;
};

/** The result of {@link runSignInWithPasskeyFlow}. */
export type SignInWithPasskeyFlowResult =
  ClientView<FinishSignInWithPasskeyResult> | SignInError<PasskeyClientError>;

/** The errors that a sign-in from autofill reports. */
export type PasskeyAutofillError =
  | Extract<FinishSignInWithPasskeyResult, { status: "error" }>["userError"]
  | PasskeyClientError;

/** The result of {@link runAddPasskeyFlow}. */
export type AddPasskeyFlowResult =
  | FinishAddPasskeyResult
  | Extract<StartAddPasskeyResult, { success: false }>
  | PasskeyClientFailure;

/**
 * Sign in from a button: the browser lists the passkeys it holds for the
 * relying party, and the one the user picks names the account.
 */
export async function runSignInWithPasskeyFlow(
  ctx: SignInFlowContext,
): Promise<SignInWithPasskeyFlowResult> {
  const { convex, api, signInApi, setSession, ceremonies } = ctx;

  if (!ceremonies.isSupported()) {
    return { status: "error", userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const { options } = await convex.mutation(api.startSignInWithPasskey, {});
  const ceremony = await ceremonies.authenticate(options);
  if (!ceremony.success) {
    return { status: "error", userError: ceremony.userError };
  }
  const result = await signInApi.mutation(api.finishSignInWithPasskey, {
    response: ceremony.response,
  });
  if (result.status === "complete") {
    await setSession(result.tokens);
  }
  return result;
}

/**
 * Add a passkey to the account of the signed-in user. The user must have
 * authenticated recently; otherwise the flow returns
 * `REAUTHENTICATION_REQUIRED` before the browser asks for anything.
 */
export async function runAddPasskeyFlow(ctx: {
  convex: ConvexReactClient;
  api: AddPasskeyApi;
  ceremonies: ResolvedPasskeyCeremonies;
}): Promise<AddPasskeyFlowResult> {
  const { convex, api, ceremonies } = ctx;

  if (!ceremonies.isSupported()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await convex.mutation(api.startAddPasskey, {});
  if (!start.success) {
    return start;
  }
  const registration = await ceremonies.register(start.options);
  if (!registration.success) {
    return registration;
  }
  return await convex.mutation(api.finishAddPasskey, {
    response: registration.response,
  });
}
