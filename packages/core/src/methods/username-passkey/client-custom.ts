/**
 * The passkey flows on ceremonies that the app provides, for example on a
 * native passkey library, for client libraries of other frameworks. Exported
 * at `@convex-dev/auth/methods/username-passkey/client-custom`.
 *
 * It does not import the browser ceremonies of `client.ts` or
 * `@simplewebauthn/browser`. `client.ts` exports everything that is here, so
 * a client library on the browser ceremonies imports only that one.
 *
 * {@link resolveCeremonies} turns the {@link PasskeyCeremonies} of an app into
 * the {@link ResolvedPasskeyCeremonies} that the flows take.
 *
 * The flows ({@link runSignInOrSignUpFlow}, {@link runAddPasskeyFlow} and
 * {@link runRemovePasskeyFlow}) run the ceremonies against the mutations of
 * the method. They leave three things to the caller, which the React hooks
 * do:
 *
 * - Unlike the ceremonies, a flow rejects when a mutation throws. The hooks
 *   fold a throw into `OTHER_ERROR`.
 * - Nothing stops two flows from running at once. The hooks answer
 *   `ALREADY_PENDING` while a ceremony is open.
 * - A flow does not end a pending autofill request, and the browser runs one
 *   ceremony at a time. The hooks abort the autofill request before a modal
 *   ceremony and start a new one after it.
 *
 * The autofill loop itself stays in the React hooks. A client library for
 * another framework writes its own on
 * {@link ResolvedPasskeyCeremonies.authenticateWithAutofill}, and starts the
 * request again with new options before {@link CHALLENGE_TTL_MS} passes.
 *
 * @module
 */

export {
  foldClientError,
  resolveCeremonies,
  type PasskeyAuthenticationResponse,
  type PasskeyAuthenticationResult,
  type PasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyClientFailure,
  type PasskeyRegistrationResponse,
  type PasskeyRegistrationResult,
  type ResolvedPasskeyCeremonies,
} from "./ceremonies.ts";
export {
  runSignInOrSignUpFlow,
  type ProtocolUserError,
  type SignInFlowContext,
  type SignInFlowResult,
  type UsernamePasskeyApi,
  type UsernamePasskeyAutofillError,
} from "./flows.ts";
export {
  runAddPasskeyFlow,
  runRemovePasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type ManagementFlowContext,
  type RemovePasskeyApi,
  type RemovePasskeyFlowResult,
} from "./management/flows.ts";
export type {
  FinishAddPasskeyResult,
  StartAddPasskeyResult,
  VerifyAddPasskeyResult,
} from "./management/add.ts";
export type {
  FinishRemovePasskeyResult,
  StartRemovePasskeyResult,
} from "./management/remove.ts";
export type { RenamePasskeyResult } from "./management/rename.ts";
// The `Wire…` types are the exact shapes of the mutations of the method.
export type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "../../components/passkey/validation.ts";
export { CHALLENGE_TTL_MS } from "../../components/passkey/constants.ts";
