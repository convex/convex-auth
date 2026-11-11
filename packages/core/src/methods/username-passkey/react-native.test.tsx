// @vitest-environment jsdom
//
// The hooks of the React Native entry, with `react-native-passkeys` mocked.
// The browser WebAuthn globals (`PublicKeyCredential`, `isSecureContext`)
// stay absent, as they are in React Native, and `@simplewebauthn/browser`
// throws if anything calls it.
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { anyApi, getFunctionName, type FunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import type { AuthSignInApi } from "../../react/client.tsx";
import { AuthProvider } from "../../react/client.tsx";
import { useAuthToken } from "../../react/index.tsx";
import { foldNativeError } from "./nativeClient.ts";
import {
  useAddPasskey,
  useRemovePasskey,
  useSignInWithUsernamePasskey,
  type AddPasskeyApi,
  type RemovePasskeyApi,
  type UsernamePasskeyApi,
} from "./react-native.tsx";

const passkeys = vi.hoisted(() => ({
  isSupported: vi.fn(() => true),
  create: vi.fn(),
  get: vi.fn(),
}));

vi.mock("react-native-passkeys", () => passkeys);

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: () => {
    throw new Error("The React Native hooks called @simplewebauthn/browser");
  },
  startAuthentication: () => {
    throw new Error("The React Native hooks called @simplewebauthn/browser");
  },
}));

const mutations = {
  startSignInWithUsernamePasskey: vi.fn(),
  finishSignInWithUsernamePasskey: vi.fn(),
  finishSignUpWithUsernamePasskey: vi.fn(),
  startAutofillSignInWithUsernamePasskey: vi.fn(),
  startAddPasskey: vi.fn(),
  verifyAddPasskey: vi.fn(),
  finishAddPasskey: vi.fn(),
  startRemovePasskey: vi.fn(),
  finishRemovePasskey: vi.fn(),
};
const runMutation = (fn: FunctionReference<"mutation">, args: unknown) =>
  mutations[getFunctionName(fn).split(":")[1] as keyof typeof mutations](args);
const signInApi = { mutation: runMutation } as unknown as AuthSignInApi;
const convexClient = { mutation: runMutation } as unknown as ConvexReactClient;
const api = () =>
  anyApi.auth as unknown as UsernamePasskeyApi &
    AddPasskeyApi &
    RemovePasskeyApi;

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const creationOptions = {
  rp: { id: "example.com", name: "Test app" },
  user: { id: "handle-1", name: "alice", displayName: "alice" },
  challenge: "challenge-1",
  pubKeyCredParams: [{ alg: -7, type: "public-key" as const }],
  timeout: 600000,
  excludeCredentials: [],
  authenticatorSelection: {
    residentKey: "required" as const,
    requireResidentKey: true as const,
    userVerification: "required" as const,
  },
  attestation: "none" as const,
  extensions: {},
};

const requestOptions = {
  challenge: "challenge-1",
  timeout: 600000,
  rpId: "example.com",
  allowCredentials: [],
  userVerification: "required" as const,
};

// What `Passkeys.create()` resolves with on iOS: the convenience fields
// that the hooks must prune off the wire, including a function.
const nativeRegistration = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal"],
    publicKey: "public-key",
    getPublicKey: () => "public-key",
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: { credProps: { rk: true } },
  type: "public-key",
};

// What `Passkeys.get()` resolves with on Android: Gson fills the missing
// optional fields with `null`.
const nativeAssertion = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "auth-data",
    signature: "signature",
    userHandle: null,
  },
  authenticatorAttachment: null,
  clientExtensionResults: {},
  type: "public-key",
};

const wireRegistration = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal"],
  },
  clientExtensionResults: {},
  type: "public-key",
};

const wireAssertion = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "auth-data",
    signature: "signature",
  },
  clientExtensionResults: {},
  type: "public-key",
};

/** An exception the way Expo surfaces one from iOS. */
function iosError(name: string, code: string) {
  return Object.assign(new Error("The passkey request failed"), { name, code });
}

/** A rejection the way the Android module surfaces one. */
function androidError(message: string, code = "Passkey Get") {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  // React Native has neither of these.
  vi.stubGlobal("PublicKeyCredential", undefined);
  vi.stubGlobal("isSecureContext", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const mock of Object.values(mutations)) {
    mock.mockReset();
  }
  passkeys.isSupported.mockReset().mockReturnValue(true);
  passkeys.create.mockReset();
  passkeys.get.mockReset();
});

function makeWrapper() {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: "https://happy-animal-123.convex.cloud",
  });
  return ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    </AuthProvider>
  );
}

function renderSignIn() {
  return renderHook(
    () => ({
      token: useAuthToken(),
      passkey: useSignInWithUsernamePasskey(api()),
    }),
    { wrapper: makeWrapper() },
  );
}

describe("useSignInWithUsernamePasskey (React Native)", () => {
  test("signs up through Passkeys.create and sends the pruned response", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue({
      success: true,
      step: "register",
      options: creationOptions,
    });
    passkeys.create.mockResolvedValue(nativeRegistration);
    mutations.finishSignUpWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
    });
    const { result } = renderSignIn();

    let outcome;
    await act(async () => {
      outcome = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(outcome).toEqual({
      status: "complete",
      tokens: bundle,
      flow: "signUp",
    });
    expect(passkeys.create).toHaveBeenCalledWith(creationOptions);
    expect(mutations.finishSignUpWithUsernamePasskey).toHaveBeenCalledWith({
      username: "alice",
      response: wireRegistration,
    });
    await waitFor(() => expect(result.current.token).toBe("access-1"));
  });

  test("signs in through Passkeys.get and drops the null fields", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue({
      success: true,
      step: "authenticate",
      options: requestOptions,
    });
    passkeys.get.mockResolvedValue(nativeAssertion);
    mutations.finishSignInWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
    });
    const { result } = renderSignIn();

    let outcome;
    await act(async () => {
      outcome = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(outcome).toEqual({
      status: "complete",
      tokens: bundle,
      flow: "signIn",
    });
    expect(passkeys.get).toHaveBeenCalledWith(requestOptions);
    expect(mutations.finishSignInWithUsernamePasskey).toHaveBeenCalledWith({
      response: wireAssertion,
    });
  });

  test("reports WEBAUTHN_UNSUPPORTED without calling the server", async () => {
    passkeys.isSupported.mockReturnValue(false);
    const { result } = renderSignIn();

    let outcome;
    await act(async () => {
      outcome = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(outcome).toEqual({
      status: "error",
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(mutations.startSignInWithUsernamePasskey).not.toHaveBeenCalled();
  });

  test("reports WEBAUTHN_UNSUPPORTED when the native module is missing", async () => {
    passkeys.isSupported.mockImplementation(() => {
      throw new Error("Cannot find native module 'ReactNativePasskeys'");
    });
    const { result } = renderSignIn();

    let outcome;
    await act(async () => {
      outcome = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(outcome).toEqual({
      status: "error",
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
  });

  test("folds a cancelled ceremony into CEREMONY_ABORTED", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue({
      success: true,
      step: "authenticate",
      options: requestOptions,
    });
    passkeys.get.mockRejectedValue(
      iosError("UserCancelledException", "ERR_USER_CANCELLED"),
    );
    const { result } = renderSignIn();

    let outcome;
    await act(async () => {
      outcome = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(outcome).toEqual({
      status: "error",
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(mutations.finishSignInWithUsernamePasskey).not.toHaveBeenCalled();
  });

  test("reports autofill as unavailable and never starts it", async () => {
    const { result } = renderSignIn();

    await waitFor(() =>
      expect(result.current.passkey.autofill).toEqual({
        available: false,
        status: "stopped",
        lastError: null,
      }),
    );
    expect(
      mutations.startAutofillSignInWithUsernamePasskey,
    ).not.toHaveBeenCalled();
  });
});

describe("passkey management (React Native)", () => {
  test("useAddPasskey re-authenticates, then registers", async () => {
    mutations.startAddPasskey.mockResolvedValue({
      success: true,
      options: requestOptions,
    });
    passkeys.get.mockResolvedValue(nativeAssertion);
    mutations.verifyAddPasskey.mockResolvedValue({
      success: true,
      options: creationOptions,
    });
    passkeys.create.mockResolvedValue(nativeRegistration);
    mutations.finishAddPasskey.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAddPasskey(api()), {
      wrapper: makeWrapper(),
    });

    let outcome;
    await act(async () => {
      outcome = await result.current.addPasskey();
    });

    expect(outcome).toEqual({ success: true });
    expect(mutations.verifyAddPasskey).toHaveBeenCalledWith({
      response: wireAssertion,
    });
    expect(mutations.finishAddPasskey).toHaveBeenCalledWith({
      response: wireRegistration,
    });
  });

  test("drops the transports that the library does not know", async () => {
    // Passkeys registered on other clients can carry transports that the
    // iOS enum of `react-native-passkeys` rejects.
    mutations.startAddPasskey.mockResolvedValue({
      success: true,
      options: {
        ...requestOptions,
        allowCredentials: [
          { id: "cred-1", type: "public-key", transports: ["internal", "x"] },
        ],
      },
    });
    passkeys.get.mockResolvedValue(nativeAssertion);
    mutations.verifyAddPasskey.mockResolvedValue({
      success: true,
      options: {
        ...creationOptions,
        excludeCredentials: [
          { id: "cred-1", type: "public-key", transports: ["usb", "cable"] },
          { id: "cred-2", type: "public-key" },
        ],
      },
    });
    passkeys.create.mockResolvedValue(nativeRegistration);
    mutations.finishAddPasskey.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useAddPasskey(api()), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.addPasskey();
    });

    expect(passkeys.get).toHaveBeenCalledWith({
      ...requestOptions,
      allowCredentials: [
        { id: "cred-1", type: "public-key", transports: ["internal"] },
      ],
    });
    expect(passkeys.create).toHaveBeenCalledWith({
      ...creationOptions,
      excludeCredentials: [
        { id: "cred-1", type: "public-key", transports: ["usb"] },
        { id: "cred-2", type: "public-key" },
      ],
    });
  });

  test("useAddPasskey folds an excluded credential on Android", async () => {
    mutations.startAddPasskey.mockResolvedValue({
      success: true,
      options: requestOptions,
    });
    passkeys.get.mockResolvedValue(nativeAssertion);
    mutations.verifyAddPasskey.mockResolvedValue({
      success: true,
      options: creationOptions,
    });
    passkeys.create.mockRejectedValue(
      androidError(
        "DomError: InvalidStateError - credential already registered",
        "Passkey Create",
      ),
    );
    const { result } = renderHook(() => useAddPasskey(api()), {
      wrapper: makeWrapper(),
    });

    let outcome;
    await act(async () => {
      outcome = await result.current.addPasskey();
    });

    expect(outcome).toEqual({
      success: false,
      userError: { error: "PASSKEY_ALREADY_REGISTERED" },
    });
    expect(mutations.finishAddPasskey).not.toHaveBeenCalled();
  });

  test("useRemovePasskey re-authenticates, then removes", async () => {
    mutations.startRemovePasskey.mockResolvedValue({
      success: true,
      options: requestOptions,
    });
    passkeys.get.mockResolvedValue(nativeAssertion);
    mutations.finishRemovePasskey.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useRemovePasskey(api()), {
      wrapper: makeWrapper(),
    });

    let outcome;
    await act(async () => {
      outcome = await result.current.removePasskey("passkey-1");
    });

    expect(outcome).toEqual({ success: true });
    expect(mutations.finishRemovePasskey).toHaveBeenCalledWith({
      passkeyId: "passkey-1",
      response: wireAssertion,
    });
  });
});

describe("foldNativeError", () => {
  test.each([
    [
      "iOS cancel",
      iosError("UserCancelledException", "ERR_USER_CANCELLED"),
      "get",
      "CEREMONY_ABORTED",
    ],
    [
      "Android cancel",
      androidError("UserCancelled"),
      "get",
      "CEREMONY_ABORTED",
    ],
    [
      "Android no passkey",
      androidError("NoCredentials"),
      "get",
      "CEREMONY_ABORTED",
    ],
    [
      "Android NotAllowedError",
      androidError("DomError: NotAllowedError - timed out"),
      "get",
      "CEREMONY_ABORTED",
    ],
    [
      "the wrapper's NotSupportedError",
      Object.assign(new Error("Passkey are not supported"), {
        name: "NotSupportedError",
      }),
      "create",
      "WEBAUTHN_UNSUPPORTED",
    ],
    [
      "iOS unsupported version",
      iosError("NotSupportedException", "ERR_NOT_SUPPORTED"),
      "create",
      "WEBAUTHN_UNSUPPORTED",
    ],
    [
      "Android excluded credential",
      androidError("DomError: InvalidStateError - exists", "Passkey Create"),
      "create",
      "PASSKEY_ALREADY_REGISTERED",
    ],
    [
      "InvalidStateError outside a registration",
      androidError("DomError: InvalidStateError - exists"),
      "get",
      "OTHER_ERROR",
    ],
    [
      "iOS misconfigured associated domains",
      iosError("NotConfiguredException", "ERR_NOT_CONFIGURED"),
      "get",
      "OTHER_ERROR",
    ],
    ["a non-object", "boom", "get", "OTHER_ERROR"],
  ] as const)("%s", (_label, cause, ceremony, expected) => {
    expect(foldNativeError(cause, ceremony).error).toBe(expected);
  });

  test("keeps the thrown value on OTHER_ERROR", () => {
    const cause = iosError("UnknownException", "ERR_UNKNOWN");
    expect(foldNativeError(cause, "get")).toEqual({
      error: "OTHER_ERROR",
      cause,
    });
  });
});
