// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { anyApi, getFunctionName, type FunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import type { AuthSignInApi } from "../../react/client.tsx";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { useAuthToken } from "../../react/index.tsx";
import {
  UsernamePasskeyApi,
  SignInWithUsernamePasskeyResult,
  useSignInWithUsernamePasskey,
} from "./react.tsx";
import { usePasskeyAutofill, usePasskeyCeremonySlot } from "./react_impl.tsx";

import { toBase64URL } from "./base64url.ts";

const noopAutofill = {
  pauseAutofillFlow: () => {},
  resumeAutofillFlow: () => {},
  isAutofillSigningIn: () => false,
};

// The hook calls several different mutations, so both call paths dispatch on
// the name of the reference to one mock per mutation.
const mutations = {
  startSignInWithUsernamePasskey: vi.fn(),
  finishSignInWithUsernamePasskey: vi.fn(),
  finishSignUpWithUsernamePasskey: vi.fn(),
  startAutofillSignInWithUsernamePasskey: vi.fn(),
};
const runMutation = (fn: FunctionReference<"mutation">, args: unknown) =>
  // `anyApi.auth.startSignInWithUsernamePasskey` is named
  // `auth:startSignInWithUsernamePasskey`.
  mutations[getFunctionName(fn).split(":")[1] as keyof typeof mutations](args);

// The two session-minting mutations run through the injected `AuthSignInApi`,
// which the tests substitute rather than mocking a transport.
const signInApi = { mutation: runMutation } as unknown as AuthSignInApi;

// The two challenge mutations run on the Convex client from `useConvex()`,
// which the tests stand in for with the same dispatcher.
const convexClient = { mutation: runMutation } as unknown as ConvexReactClient;

// `anyApi` is what the generated `api` is. It returns a new reference object
// on each property access, as `api.auth` does.
const passkeyApi = () => anyApi.auth as unknown as UsernamePasskeyApi;

//------------------------------------------------------------------------------
// The fake browser ceremonies
//------------------------------------------------------------------------------
//
// Modal ceremonies run through `@simplewebauthn/browser`, which the tests
// mock; the conditional request runs through `navigator.credentials`, which
// they stub. Both share one ceremony slot, the way the browser does:
// starting any ceremony displaces a pending one, which rejects with an
// `AbortError`. The tests own what each ceremony resolves with through
// `ceremonyCreate` / `ceremonyGet` / `conditionalGet`.

const ceremonyCreate = vi.fn();
const ceremonyGet = vi.fn();
// The conditional request does not go through the library (the hook owns
// its `AbortSignal`), so it has its own control. It resolves with a
// `PublicKeyCredential`, the way `navigator.credentials.get` does, rather
// than with the JSON the library returns.
const conditionalGet = vi.fn();

function abortError() {
  const error = new Error("Ceremony was aborted");
  error.name = "AbortError";
  return error;
}

let abortPending: ((reason: Error) => void) | null = null;

function runInCeremonySlot<T>(run: () => Promise<T>): Promise<T> {
  abortPending?.(abortError());
  return new Promise<T>((resolve, reject) => {
    abortPending = reject;
    const mine = reject;
    run().then(
      (value) => {
        if (abortPending === mine) abortPending = null;
        resolve(value);
      },
      (cause) => {
        if (abortPending === mine) abortPending = null;
        reject(cause);
      },
    );
  });
}

/**
 * The fake `navigator.credentials`, which the conditional path calls. It
 * shares the ceremony slot with the library fake, the way the browser does,
 * and it honours the caller's signal: an already-aborted one is refused on
 * entry, which is the property the hook relies on.
 */
function stubCredentials() {
  Object.defineProperty(globalThis.navigator, "credentials", {
    configurable: true,
    value: {
      get: (options: { signal?: AbortSignal }) =>
        runInCeremonySlot(
          () =>
            new Promise((resolve, reject) => {
              const signal = options.signal;
              if (signal?.aborted) {
                reject(abortError());
                return;
              }
              signal?.addEventListener("abort", () => reject(abortError()), {
                once: true,
              });
              conditionalGet(options).then(resolve, reject);
            }),
        ),
    },
  });
}

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: (options: unknown) =>
    runInCeremonySlot(() => ceremonyCreate(options)),
  startAuthentication: (options: unknown) =>
    runInCeremonySlot(() => ceremonyGet(options)),
  WebAuthnAbortService: {
    cancelCeremony: () => {
      abortPending?.(abortError());
      abortPending = null;
    },
  },
}));

/** A ceremony that stays pending until the slot aborts it, like a real
 * conditional-mediation request until the user picks a passkey. */
const pendingForever = () => new Promise<never>(() => {});

const bytes = (text: string) =>
  Uint8Array.from(text, (character) => character.charCodeAt(0)).buffer;

/**
 * The wire form of a short ASCII string: canonical base64url, so that a
 * value decoded from it encodes back to exactly the same string.
 */
const wire = (text: string) => toBase64URL(bytes(text));

class FakePublicKeyCredential {
  static isConditionalMediationAvailable = async () => true;
}

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The options objects the start mutations return, ready for the browser.
const creationOptions = {
  rp: { id: "localhost", name: "Test app" },
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
  rpId: "localhost",
  allowCredentials: [
    { id: "cred-1", type: "public-key" as const, transports: ["internal"] },
  ],
  userVerification: "required" as const,
};

// The same assertion in the shape `navigator.credentials.get` resolves
// with: bytes rather than base64url. It encodes back to
// `wireAuthenticationResponse`.
const conditionalCredential = {
  id: wire("cred-1"),
  rawId: bytes("cred-1"),
  response: {
    clientDataJSON: bytes("client-data"),
    authenticatorData: bytes("auth-data"),
    signature: bytes("signature"),
    userHandle: bytes("handle-1"),
  },
  type: "public-key",
};

const registerStart = {
  success: true,
  step: "register",
  options: creationOptions,
};

const authenticateStart = {
  success: true,
  step: "authenticate",
  options: requestOptions,
};

// What the library resolves a `create()` ceremony with, including the
// convenience fields that the hooks must prune off the wire.
const registrationResponse = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal", "hybrid"],
    publicKey: "public-key",
    publicKeyAlgorithm: -7,
    authenticatorData: "auth-data",
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: { credProps: { rk: true } },
  type: "public-key",
};

// What the library resolves a `get()` ceremony with.
const authenticationResponse = {
  id: wire("cred-1"),
  rawId: wire("cred-1"),
  response: {
    clientDataJSON: wire("client-data"),
    authenticatorData: wire("auth-data"),
    signature: wire("signature"),
    userHandle: wire("handle-1"),
  },
  clientExtensionResults: {},
  type: "public-key",
};

// The wire forms of the two responses, as the finish mutations receive them.
const wireRegistrationResponse = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal", "hybrid"],
  },
  clientExtensionResults: {},
  type: "public-key",
};

const wireAuthenticationResponse = {
  id: wire("cred-1"),
  rawId: wire("cred-1"),
  response: {
    clientDataJSON: wire("client-data"),
    authenticatorData: wire("auth-data"),
    signature: wire("signature"),
    userHandle: wire("handle-1"),
  },
  clientExtensionResults: {},
  type: "public-key",
};

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("isSecureContext", true);
  stubCredentials();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of Object.values(mutations)) {
    mock.mockReset();
  }
  ceremonyCreate.mockReset();
  ceremonyGet.mockReset();
  conditionalGet.mockReset();
  abortPending = null;
});

function makeWrapper() {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  return ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    </AuthProvider>
  );
}

function renderPasskey() {
  return renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      passkey: useSignInWithUsernamePasskey(passkeyApi()),
    }),
    { wrapper: makeWrapper() },
  );
}

describe("useSignInWithUsernamePasskey signIn", () => {
  test("sign-up success runs the registration ceremony and adopts the session", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue(registerStart);
    ceremonyCreate.mockResolvedValue(registrationResponse);
    mutations.finishSignUpWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
    });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(mutations.startSignInWithUsernamePasskey).toHaveBeenCalledWith({
      username: "alice",
    });
    // The server-built options go to the browser untouched.
    expect(ceremonyCreate).toHaveBeenCalledWith({
      optionsJSON: creationOptions,
    });
    // The response reaches the finish mutation pruned to the wire shape.
    expect(mutations.finishSignUpWithUsernamePasskey).toHaveBeenCalledWith({
      username: "alice",
      response: wireRegistrationResponse,
    });
    expect(returned).toEqual({
      status: "complete",
      tokens: bundle,
      flow: "signUp",
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("sign-in success runs the authentication ceremony and adopts the session", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue(
      authenticateStart,
    );
    ceremonyGet.mockResolvedValue(authenticationResponse);
    mutations.finishSignInWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
      username: "alice",
    });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(ceremonyGet).toHaveBeenCalledWith({
      optionsJSON: requestOptions,
    });
    expect(mutations.finishSignInWithUsernamePasskey).toHaveBeenCalledWith({
      response: wireAuthenticationResponse,
    });
    expect(returned).toEqual({
      status: "complete",
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("a startSignInWithUsernamePasskey userError becomes an error arm without a ceremony", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue({
      success: false,
      userError: { error: "USERNAME_INVALID" },
    });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "no" });
    });

    // `startSignInWithUsernamePasskey` answers with its own `success` boolean; the flow re-wraps
    // the failure so callers see the envelope's one discriminant.
    expect(returned).toEqual({
      status: "error",
      userError: { error: "USERNAME_INVALID" },
    });
    expect(ceremonyCreate).not.toHaveBeenCalled();
    expect(ceremonyGet).not.toHaveBeenCalled();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("NotAllowedError folds into CEREMONY_ABORTED", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue(
      authenticateStart,
    );
    ceremonyGet.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.passkey.pending).toBe(false);
  });

  test("a second signIn while one runs fails fast and the first completes", async () => {
    mutations.startSignInWithUsernamePasskey.mockResolvedValue(
      authenticateStart,
    );
    let resolveCeremony!: (value: unknown) => void;
    ceremonyGet.mockReturnValue(
      new Promise((resolve) => {
        resolveCeremony = resolve;
      }),
    );
    mutations.finishSignInWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
      username: "alice",
    });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let first!: Promise<SignInWithUsernamePasskeyResult>;
    act(() => {
      first = result.current.passkey.signIn({ username: "alice" });
    });
    await waitFor(() => expect(result.current.passkey.pending).toBe(true));

    // The second call must not start another ceremony or deadlock; it
    // returns a folded failure immediately.
    let second!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      second = await result.current.passkey.signIn({ username: "alice" });
    });
    expect(second).toEqual({
      status: "error",
      userError: { error: "ALREADY_PENDING" },
    });
    expect(mutations.startSignInWithUsernamePasskey).toHaveBeenCalledTimes(1);

    // The first call still completes normally.
    let firstResult!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      resolveCeremony(authenticationResponse);
      firstResult = await first;
    });
    expect(firstResult).toEqual({
      status: "complete",
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    expect(result.current.passkey.pending).toBe(false);
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("signIn keeps one identity across re-renders", async () => {
    const { result, rerender } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const firstIdentity = result.current.passkey.signIn;
    rerender();
    expect(result.current.passkey.signIn).toBe(firstIdentity);
  });

  test("signIn keeps one identity while the autofill status changes", async () => {
    mutations.startAutofillSignInWithUsernamePasskey.mockResolvedValue({
      options: requestOptions,
    });
    conditionalGet.mockImplementation(pendingForever);
    const { result, unmount } = renderPasskey();
    // Captured before the loop reports anything, so the assertion below
    // spans `available` null → true and `status` idle → waiting.
    const firstIdentity = result.current.passkey.signIn;

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );
    expect(result.current.passkey.signIn).toBe(firstIdentity);

    unmount();
    await act(async () => {});
  });
});

describe("useSignInWithUsernamePasskey autofill", () => {
  test("a rejecting availability check reports available: false and status 'stopped'", async () => {
    const spy = vi
      .spyOn(FakePublicKeyCredential, "isConditionalMediationAvailable")
      .mockRejectedValue(new Error("detection failed"));
    const { result, unmount } = renderPasskey();
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("stopped"),
    );
    expect(result.current.passkey.autofill.available).toBe(false);
    expect(
      mutations.startAutofillSignInWithUsernamePasskey,
    ).not.toHaveBeenCalled();
    spy.mockRestore();

    unmount();
    await act(async () => {});
  });

  test("a picked passkey signs the user in: waiting → signedIn", async () => {
    mutations.startAutofillSignInWithUsernamePasskey.mockResolvedValue({
      options: requestOptions,
    });
    conditionalGet.mockResolvedValue(conditionalCredential);
    mutations.finishSignInWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
      username: "alice",
    });
    const { result, unmount } = renderPasskey();

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signedIn"),
    );
    // The request is a conditional one, and it carries the hook's own
    // abort signal rather than one from the library's singleton.
    const call = conditionalGet.mock.calls[0][0];
    expect(call.mediation).toBe("conditional");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.publicKey.rpId).toBe(requestOptions.rpId);
    expect(mutations.finishSignInWithUsernamePasskey).toHaveBeenCalledWith({
      response: wireAuthenticationResponse,
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.passkey.autofill.lastError).toBe(null);

    unmount();
    await act(async () => {});
  });

  test("a success after a failed assertion clears lastError", async () => {
    mutations.startAutofillSignInWithUsernamePasskey.mockResolvedValue({
      options: requestOptions,
    });
    conditionalGet.mockResolvedValue(conditionalCredential);
    // The first assertion fails on the server; the loop retries with a
    // fresh challenge and the second one succeeds.
    mutations.finishSignInWithUsernamePasskey
      .mockResolvedValueOnce({
        status: "error",
        userError: { error: "CHALLENGE_EXPIRED" },
      })
      .mockResolvedValueOnce({
        status: "complete",
        tokens: bundle,
        username: "alice",
      });
    const { result, unmount } = renderPasskey();

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signedIn"),
    );
    expect(result.current.auth.isAuthenticated).toBe(true);
    // The failure of the first attempt must not stay visible after the
    // user is signed in.
    expect(result.current.passkey.autofill.lastError).toBe(null);

    unmount();
    await act(async () => {});
  });

  test("pending is true while the server verifies an autofill sign-in, and signIn refuses", async () => {
    mutations.startAutofillSignInWithUsernamePasskey.mockResolvedValue({
      options: requestOptions,
    });
    conditionalGet.mockResolvedValue(conditionalCredential);
    let resolveFinish!: (value: unknown) => void;
    mutations.finishSignInWithUsernamePasskey.mockReturnValue(
      new Promise((resolve) => {
        resolveFinish = resolve;
      }),
    );
    const { result, unmount } = renderPasskey();

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signingIn"),
    );
    expect(result.current.passkey.pending).toBe(true);

    // The verification cannot be paused, thus a modal flow must not start.
    let returned!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });
    expect(returned).toEqual({
      status: "error",
      userError: { error: "ALREADY_PENDING" },
    });
    expect(mutations.startSignInWithUsernamePasskey).not.toHaveBeenCalled();

    await act(async () => {
      resolveFinish({ status: "complete", tokens: bundle, username: "alice" });
    });
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signedIn"),
    );
    expect(result.current.passkey.pending).toBe(false);
    expect(result.current.auth.isAuthenticated).toBe(true);

    unmount();
    await act(async () => {});
  });

  test("signIn pauses the pending autofill request and resumes it after", async () => {
    mutations.startAutofillSignInWithUsernamePasskey.mockResolvedValue({
      options: requestOptions,
    });
    // The conditional (autofill) request stays pending until aborted; the
    // modal ceremony resolves. A modal ceremony while a conditional
    // request is still pending would displace it (the slot enforces this),
    // and the pause must have aborted it before that.
    let conditionalSignal: AbortSignal | undefined;
    conditionalGet.mockImplementation((options: { signal: AbortSignal }) => {
      conditionalSignal = options.signal;
      return pendingForever();
    });
    ceremonyGet.mockImplementation(() => {
      // The pause aborted the conditional request before the modal
      // ceremony started. The signal latches, thus this holds whether the
      // pause landed while the request was pending or still starting.
      expect(conditionalSignal?.aborted).toBe(true);
      return Promise.resolve(authenticationResponse);
    });
    mutations.startSignInWithUsernamePasskey.mockResolvedValue(
      authenticateStart,
    );
    mutations.finishSignInWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: bundle,
      username: "alice",
    });
    const { result, unmount } = renderPasskey();
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );
    expect(
      mutations.startAutofillSignInWithUsernamePasskey,
    ).toHaveBeenCalledTimes(1);

    let returned!: SignInWithUsernamePasskeyResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(returned).toEqual({
      status: "complete",
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    // The modal flow resumed the loop afterwards: it asks for a fresh
    // challenge and a new conditional request starts.
    await waitFor(() =>
      expect(
        mutations.startAutofillSignInWithUsernamePasskey,
      ).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );

    unmount();
    await act(async () => {});
  });
});

describe("usePasskeyCeremonySlot", () => {
  test("run returns the callback's result and tracks pending", async () => {
    const { result } = renderHook(() =>
      usePasskeyCeremonySlot({ autofill: noopAutofill }),
    );
    expect(result.current.pending).toBe(false);

    let resolveCeremony!: (value: string) => void;
    let running!: Promise<string | { success: false }>;
    act(() => {
      running = result.current.run(
        () =>
          new Promise<string>((resolve) => {
            resolveCeremony = resolve;
          }),
      );
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    let returned!: string | { success: false };
    await act(async () => {
      resolveCeremony("done");
      returned = await running;
    });
    expect(returned).toBe("done");
    expect(result.current.pending).toBe(false);
  });

  test("a second run while one is running fails fast", async () => {
    const { result } = renderHook(() =>
      usePasskeyCeremonySlot({ autofill: noopAutofill }),
    );

    let resolveCeremony!: (value: string) => void;
    act(() => {
      void result.current.run(
        () =>
          new Promise<string>((resolve) => {
            resolveCeremony = resolve;
          }),
      );
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    const second = vi.fn(async () => "second");
    let returned!: string | { success: false; userError: unknown };
    await act(async () => {
      returned = await result.current.run(second);
    });
    expect(returned).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(second).not.toHaveBeenCalled();

    await act(async () => {
      resolveCeremony("done");
    });
    expect(result.current.pending).toBe(false);
  });

  test("a thrown value folds into the failure shape", async () => {
    const { result } = renderHook(() =>
      usePasskeyCeremonySlot({ autofill: noopAutofill }),
    );
    const cause = new Error("boom");
    let returned!: never | { success: false; userError: unknown };
    await act(async () => {
      returned = await result.current.run(async () => {
        throw cause;
      });
    });
    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.pending).toBe(false);
  });

  test("run refuses while the server verifies an autofill sign-in", async () => {
    const autofill = { ...noopAutofill, isAutofillSigningIn: () => true };
    const fn = vi.fn(async () => "done");
    const { result } = renderHook(() => usePasskeyCeremonySlot({ autofill }));
    let returned: unknown;
    await act(async () => {
      returned = await result.current.run(fn);
    });
    expect(returned).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
  });

  test("run pauses the autofill gates around the callback, also on a throw", async () => {
    const calls: string[] = [];
    const autofill = {
      pauseAutofillFlow: () => {
        calls.push("pause");
      },
      resumeAutofillFlow: () => {
        calls.push("resume");
      },
      isAutofillSigningIn: () => false,
    };
    const { result } = renderHook(() => usePasskeyCeremonySlot({ autofill }));
    await act(async () => {
      await result.current.run(async () => {
        calls.push("ceremony");
        throw new Error("boom");
      });
    });
    expect(calls).toEqual(["pause", "ceremony", "resume"]);
  });
});

describe("usePasskeyAutofill", () => {
  test("hands the picked response to onAssertion and reports success", async () => {
    conditionalGet.mockResolvedValue(conditionalCredential);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );

    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(result.current.available).toBe(true);
    expect(result.current.lastError).toBe(null);
    expect(onAssertion).toHaveBeenCalledWith(wireAuthenticationResponse);

    unmount();
    await act(async () => {});
  });

  test("stops after three failed assertions in a row", async () => {
    conditionalGet.mockResolvedValue(conditionalCredential);
    const start = vi.fn(async () => requestOptions);
    const flowError = { error: "VERIFICATION_FAILED" as const };
    const onAssertion = vi.fn(async () => ({
      success: false as const,
      userError: flowError,
    }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );

    await waitFor(() => expect(result.current.status).toBe("stopped"));
    // Each retry asks for a fresh challenge.
    expect(start).toHaveBeenCalledTimes(3);
    expect(onAssertion).toHaveBeenCalledTimes(3);
    expect(result.current.lastError).toBe(flowError);

    unmount();
    await act(async () => {});
  });

  test("a pause taken before the loop starts holds the first request", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );

    // Pause right away, while feature detection is still in flight: the
    // loop must park before it mints its first challenge.
    act(() => {
      result.current.pauseAutofillFlow();
    });
    await act(async () => {});
    expect(start).not.toHaveBeenCalled();

    act(() => {
      result.current.resumeAutofillFlow();
    });
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {});
  });

  test("a pause while the challenge is being minted holds the request", async () => {
    conditionalGet.mockImplementation(pendingForever);
    // The start mutation stays pending, which puts the loop in the state
    // that used to lose a pause: it has decided to start a request but has
    // not called the browser yet.
    let mintChallenge!: () => void;
    let mintCalls = 0;
    const start = vi.fn(() => {
      mintCalls += 1;
      if (mintCalls > 1) {
        // The round after the resume mints without ceremony.
        return Promise.resolve(requestOptions);
      }
      return new Promise<typeof requestOptions>((resolve) => {
        mintChallenge = () => resolve(requestOptions);
      });
    });
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // The pause lands first, then the challenge arrives. No request may
    // reach the browser: the loop would take the ceremony slot from
    // whoever the pause was making room for.
    act(() => {
      result.current.pauseAutofillFlow();
    });
    await act(async () => {
      mintChallenge();
    });
    expect(conditionalGet).not.toHaveBeenCalled();

    act(() => {
      result.current.resumeAutofillFlow();
    });
    await waitFor(() => expect(conditionalGet).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {});
  });

  test("a ceremony that takes the slot without pausing stops the flow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(result.current.status).toBe("waiting"));

    // A ceremony that skipped `pause()` takes the slot, which ends the
    // pending conditional request without this hook aborting it. The loop
    // must not start a new request: it would abort that ceremony right
    // back, and against a browser that refuses conditional requests it
    // would spin on the start mutation.
    act(() => {
      abortPending?.(abortError());
      abortPending = null;
    });
    await waitFor(() => expect(result.current.status).toBe("stopped"));
    expect(result.current.lastError).toEqual({ error: "CEREMONY_ABORTED" });
    expect(start).toHaveBeenCalledTimes(1);
    // The developer is told, because this is a misuse of the hook that
    // nothing else can report: the foreign ceremony itself succeeds.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("autofill has stopped");

    unmount();
    await act(async () => {});
  });

  test("an autofill effect restart mid-ceremony keeps the pause", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        const autofill = usePasskeyAutofill({ start, onAssertion, enabled });
        const modal = usePasskeyCeremonySlot({ autofill });
        return { autofill, modal };
      },
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));

    let finishCeremony!: () => void;
    let running!: Promise<string | { success: false }>;
    act(() => {
      running = result.current.modal.run(
        () =>
          new Promise<string>((resolve) => {
            finishCeremony = () => resolve("done");
          }),
      );
    });
    await waitFor(() => expect(result.current.modal.pending).toBe(true));
    expect(start).toHaveBeenCalledTimes(1);

    // Restart the autofill effect while the modal ceremony is running. The
    // pause lives on the hook, so the restarted loop must stay parked
    // instead of starting a request that would displace the ceremony.
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {});
    expect(start).toHaveBeenCalledTimes(1);

    let returned!: string | { success: false };
    await act(async () => {
      finishCeremony();
      returned = await running;
    });
    expect(returned).toBe("done");
    expect(result.current.modal.pending).toBe(false);
    // The resume of the finished ceremony lets the restarted loop start a
    // fresh request.
    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {});
  });

  test("a modal ceremony that ends before its abort settles restarts the loop", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() => {
      const autofill = usePasskeyAutofill({ start, onAssertion });
      const modal = usePasskeyCeremonySlot({ autofill });
      return { autofill, modal };
    });
    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));

    // The modal ceremony pauses the loop, aborting the pending request,
    // and is over before that abort settles. The loop then sees its own
    // abort with the pause already retracted: it must not read that as a
    // foreign ceremony that displaced it and park for good.
    let returned!: string | { success: false };
    await act(async () => {
      returned = await result.current.modal.run(async () => "done");
    });
    expect(returned).toBe("done");

    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {});
  });

  test("a challenge that aged while no timer ran is refreshed when the user comes back", async () => {
    // Stand in for a computer that sleeps: the wall clock moves on, while
    // no page timer fires.
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(1);

    now += 9 * 60 * 1000;
    // The user focuses the username field to open its autocompletion
    // list. The pending challenge is too old to redeem, so the request
    // starts over with a fresh one before the user can pick a passkey.
    act(() => {
      document.dispatchEvent(new Event("focusin"));
    });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(conditionalGet).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("waiting");
    expect(result.current.lastError).toBe(null);

    unmount();
    await act(async () => {});
  });

  test("the periodic check refreshes a challenge that aged past the refresh point", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(result.current.status).toBe("waiting"));

    // The hook's staleness check is the interval it sets with its own
    // period; run it by hand rather than waiting for it.
    const check = setIntervalSpy.mock.calls.find(
      ([, ms]) => ms === 10 * 1000,
    )?.[0] as () => void;
    expect(check).toBeTypeOf("function");

    // A fresh challenge stays pending.
    now += 60 * 1000;
    act(() => check());
    await act(async () => {});
    expect(start).toHaveBeenCalledTimes(1);

    // An old one starts over.
    now += 8 * 60 * 1000;
    act(() => check());
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    unmount();
    await act(async () => {});
  });

  test("coming back to the page keeps a challenge that is still fresh", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(result.current.status).toBe("waiting"));

    now += 5 * 60 * 1000;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("focusin"));
    });
    await act(async () => {});
    expect(start).toHaveBeenCalledTimes(1);
    expect(conditionalGet).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {});
  });

  test("disabling the hook stops the pending request for good", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePasskeyAutofill({ start, onAssertion, enabled }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.status).toBe("waiting"));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.available).toBe(false);
    expect(onAssertion).not.toHaveBeenCalled();
    // The loop really exited: no fresh challenge is minted afterwards.
    await act(async () => {});
    expect(start).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {});
  });
});
