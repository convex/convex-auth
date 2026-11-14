/**
 * The client code that orchestrates the “standard” (non-autofill) passkey sign-in flow,
 * i.e. the code that runs whenever the user enters a username to sign in or sign up.
 *
 * @module
 */

import type { FunctionReference } from "convex/server";
import type {
  AuthSignInApi,
  ConvexMutationApi,
} from "../../browser/ambientSignInClient.ts";
import type {
  ClientView,
  SignInError,
  SlimTokenBundle,
  TokenBundle,
} from "../../lib/types.ts";
import type {
  ResolvedPasskeyCeremonies,
  PasskeyClientError,
} from "./ceremonies.ts";
import type {
  FinishSignInResult,
  FinishSignUpResult,
  StartAutofillSignInResult,
  StartSignInResult,
} from "./server.ts";
import type {
  WireAuthenticationResponse,
  WireRegistrationResponse,
} from "../../components/passkey/validation.ts";

type StartSignInMutation = FunctionReference<
  "mutation",
  "public",
  { username: string },
  StartSignInResult
>;

type StartAutofillSignInMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAutofillSignInResult
>;

type FinishSignUpMutation = FunctionReference<
  "mutation",
  "public",
  { username: string; response: WireRegistrationResponse },
  ClientView<FinishSignUpResult>
>;

type FinishSignInMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireAuthenticationResponse },
  ClientView<FinishSignInResult>
>;

/** The mutation references the sign-in flows drive. */
export type UsernamePasskeyApi = {
  startSignInWithUsernamePasskey: StartSignInMutation;
  startAutofillSignInWithUsernamePasskey: StartAutofillSignInMutation;
  finishSignInWithUsernamePasskey: FinishSignInMutation;
  finishSignUpWithUsernamePasskey: FinishSignUpMutation;
};

/** What the sign-in flows need from their caller. */
export type SignInFlowContext = {
  /** Runs the mutations that mint no session, like the start mutations. */
  convex: ConvexMutationApi;
  /** The mutation references the app re-exported from its `setupConvexAuth`. */
  api: UsernamePasskeyApi;
  /**
   * Runs a mutation that mints a session. The finishing mutations go
   * through this, and not through `convex`, because they must work under
   * both session models (SPA and SSR).
   */
  signInApi: AuthSignInApi;
  /** Stores a minted session. */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
  /** The passkey ceremonies of the platform. */
  ceremonies: ResolvedPasskeyCeremonies;
};

/**
 * The user-facing failures the ceremony protocol reports. `startSignInWithUsernamePasskey` and
 * the ceremonies answer with their own `success` boolean rather than
 * the shared envelope, so this flow re-wraps their payloads as error arms and
 * callers only ever see the one discriminant.
 */
type ProtocolUserError =
  | Extract<StartSignInResult, { success: false }>["userError"]
  | PasskeyClientError;

/**
 * The result of {@link runSignInOrSignUpFlow}.
 *
 * A completed sign-in carries a `flow` discriminant: `"signUp"` when the
 * ceremony created a new account, `"signIn"` when it authenticated an existing
 * one.
 */
export type SignInFlowResult =
  | (Extract<ClientView<FinishSignUpResult>, { status: "complete" }> & {
      flow: "signUp";
    })
  | (Extract<ClientView<FinishSignInResult>, { status: "complete" }> & {
      flow: "signIn";
    })
  | Extract<ClientView<FinishSignUpResult>, { status: "error" }>
  | Extract<ClientView<FinishSignInResult>, { status: "error" }>
  | SignInError<ProtocolUserError>;

/** The errors the autofill sign-in flow reports. */
export type UsernamePasskeyAutofillError =
  | Extract<FinishSignInResult, { status: "error" }>["userError"]
  | PasskeyClientError;

/**
 * The identifier-first sign-in flow: the start mutation tells whether the
 * username is new, then one ceremony makes a passkey or uses one.
 */
export async function runSignInOrSignUpFlow(
  ctx: SignInFlowContext,
  { username }: { username: string },
): Promise<SignInFlowResult> {
  const { convex, api, signInApi, setSession, ceremonies } = ctx;

  if (!ceremonies.isSupported()) {
    return { status: "error", userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await convex.mutation(api.startSignInWithUsernamePasskey, {
    username,
  });
  if (!start.success) {
    return { status: "error", userError: start.userError };
  }

  if (start.step === "register") {
    const ceremony = await ceremonies.register(start.options);
    if (!ceremony.success) {
      return { status: "error", userError: ceremony.userError };
    }
    const result = await signInApi.mutation(
      api.finishSignUpWithUsernamePasskey,
      {
        username,
        response: ceremony.response,
      },
    );
    if (result.status !== "complete") {
      return result;
    }
    await setSession(result.tokens);
    return { ...result, flow: "signUp" };
  }

  const ceremony = await ceremonies.authenticate(start.options);
  if (!ceremony.success) {
    return { status: "error", userError: ceremony.userError };
  }
  const result = await signInApi.mutation(api.finishSignInWithUsernamePasskey, {
    response: ceremony.response,
  });
  if (result.status !== "complete") {
    return result;
  }
  await setSession(result.tokens);
  return { ...result, flow: "signIn" };
}
