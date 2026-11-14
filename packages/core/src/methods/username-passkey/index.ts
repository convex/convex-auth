/**
 * The client of the username + passkey method without React, exported at
 * `@convex-dev/auth/methods/username-passkey`: the WebAuthn ceremonies and the
 * flows that run them. The React hooks of the method are built on it.
 *
 * @module
 */

export {
  browserCeremonies,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WireAuthenticationResponse,
  type WireCreationOptions,
  type WireRegistrationResponse,
  type WireRequestOptions,
} from "./client.ts";
export {
  foldClientError,
  resolveCeremonies,
  type PasskeyAuthenticationResponse,
  type PasskeyCeremonies,
  type PasskeyClientError,
  type PasskeyClientFailure,
  type PasskeyRegistrationResponse,
  type ResolvedPasskeyCeremonies,
} from "./ceremonies.ts";
export {
  runSignInOrSignUpFlow,
  type SignInFlowResult,
  type UsernamePasskeyApi,
  type UsernamePasskeyAutofillError,
} from "./flows.ts";
export {
  runAddPasskeyFlow,
  runRemovePasskeyFlow,
  type AddPasskeyApi,
  type AddPasskeyFlowResult,
  type RemovePasskeyApi,
  type RemovePasskeyFlowResult,
} from "./management/flows.ts";
export type { RenamePasskeyResult } from "./management/rename.ts";
export { CHALLENGE_TTL_MS } from "../../components/passkey/constants.ts";
