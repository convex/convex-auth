// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { anyApi, getFunctionName, type FunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AddPasskeyResult,
  type AddPasskeyApi,
  type RemovePasskeyApi,
  type RemovePasskeyResult,
  useAddPasskey,
  useRemovePasskey,
} from "../react.tsx";

// The flows call several different functions and the tests assert their
// order, so every step of a flow records its name here.
const callOrder: string[] = [];

// The hooks call several different mutations, so the client dispatches on
// the name of the reference to one mock per mutation.
const mutations = {
  startAddPasskey: vi.fn(),
  verifyAddPasskey: vi.fn(),
  finishAddPasskey: vi.fn(),
  startRemovePasskey: vi.fn(),
  finishRemovePasskey: vi.fn(),
};
const runMutation = (fn: FunctionReference<"mutation">, args: unknown) => {
  // `anyApi.auth.startAddPasskey` is named `auth:startAddPasskey`.
  const name = getFunctionName(fn).split(":")[1] as keyof typeof mutations;
  callOrder.push(name);
  return mutations[name](args);
};

const convexClient = { mutation: runMutation } as unknown as ConvexReactClient;

// `anyApi` is what the generated `api` is. It returns a new reference object
// on each property access, as `api.auth` does.
const managementApi = () =>
  anyApi.auth as unknown as AddPasskeyApi & RemovePasskeyApi;

// The ceremonies run through `@simplewebauthn/browser`; the tests own what
// a `create()`/`get()` call resolves with.
const ceremonyCreate = vi.fn();
const ceremonyGet = vi.fn();

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: (options: unknown) => {
    callOrder.push("create");
    return ceremonyCreate(options);
  },
  startAuthentication: (options: unknown) => {
    callOrder.push("get");
    return ceremonyGet(options);
  },
  WebAuthnAbortService: { cancelCeremony: () => {} },
}));

class FakePublicKeyCredential {}

const requestOptions = {
  challenge: "challenge-1",
  timeout: 600000,
  rpId: "localhost",
  allowCredentials: [
    { id: "cred-1", type: "public-key" as const, transports: ["internal"] },
  ],
  userVerification: "required" as const,
};

const creationOptions = {
  rp: { id: "localhost", name: "Test app" },
  user: { id: "handle-1", name: "alice", displayName: "alice" },
  challenge: "challenge-2",
  pubKeyCredParams: [{ alg: -7, type: "public-key" as const }],
  timeout: 600000,
  excludeCredentials: [
    { id: "cred-1", type: "public-key" as const, transports: ["hybrid"] },
  ],
  authenticatorSelection: {
    residentKey: "required" as const,
    requireResidentKey: true as const,
    userVerification: "required" as const,
  },
  attestation: "none" as const,
  extensions: {},
};

const addStart = { success: true, options: requestOptions };
const addVerified = { success: true, options: creationOptions };
const removeStart = { success: true, options: requestOptions };

// What the library resolves the ceremonies with.
const authenticationResponse = {
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

const registrationResponse = {
  id: "cred-2",
  rawId: "cred-2",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal", "hybrid"],
  },
  clientExtensionResults: {},
  type: "public-key",
};

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("isSecureContext", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of Object.values(mutations)) {
    mock.mockReset();
  }
  ceremonyCreate.mockReset();
  ceremonyGet.mockReset();
  callOrder.length = 0;
});

function wrapper({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}

function renderManagement() {
  return renderHook(
    () => ({
      add: useAddPasskey(managementApi()),
      remove: useRemovePasskey(managementApi()),
    }),
    { wrapper },
  );
}

describe("useAddPasskey", () => {
  test("runs both ceremonies and calls the five functions in order", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    ceremonyGet.mockResolvedValue(authenticationResponse);
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    ceremonyCreate.mockResolvedValue(registrationResponse);
    mutations.finishAddPasskey.mockResolvedValue({
      success: true,
      passkeyId: "passkey-2",
    });
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.add.addPasskey();
    });

    expect(callOrder).toEqual([
      "startAddPasskey",
      "get",
      "verifyAddPasskey",
      "create",
      "finishAddPasskey",
    ]);
    // The server-built options go to the browser untouched.
    expect(ceremonyGet).toHaveBeenCalledWith({
      optionsJSON: requestOptions,
    });
    expect(mutations.verifyAddPasskey).toHaveBeenCalledWith({
      response: authenticationResponse,
    });
    expect(ceremonyCreate).toHaveBeenCalledWith({
      optionsJSON: creationOptions,
    });
    expect(mutations.finishAddPasskey).toHaveBeenCalledWith({
      response: registrationResponse,
    });
    expect(returned).toEqual({ success: true, passkeyId: "passkey-2" });
  });

  test("a cancelled first dialog stops the flow before the verification", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    ceremonyGet.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.add.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(callOrder).toEqual(["startAddPasskey", "get"]);
    expect(result.current.add.pending).toBe(false);
  });

  test("a cancelled second dialog stops the flow after the verification", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    ceremonyGet.mockResolvedValue(authenticationResponse);
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    ceremonyCreate.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.add.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    // The re-authentication is spent and the registration challenge stays
    // unused until it expires. No passkey is added, thus the user simply
    // starts again.
    expect(mutations.finishAddPasskey).not.toHaveBeenCalled();
  });

  test("an authenticator that holds the passkey already reports it", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    ceremonyGet.mockResolvedValue(authenticationResponse);
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    const refused = new Error("excluded");
    refused.name = "InvalidStateError";
    ceremonyCreate.mockRejectedValue(refused);
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.add.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "PASSKEY_ALREADY_REGISTERED" },
    });
  });

  test("a server userError passes through without a ceremony", async () => {
    const failure = {
      success: false,
      userError: { error: "TOO_MANY_PASSKEYS" },
    };
    mutations.startAddPasskey.mockResolvedValue(failure);
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.add.addPasskey();
    });

    expect(returned).toEqual(failure);
    expect(ceremonyGet).not.toHaveBeenCalled();
  });

  test("no WebAuthn support stops the flow before the first mutation", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.add.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(mutations.startAddPasskey).not.toHaveBeenCalled();
  });

  test("a second call while one runs comes back as ALREADY_PENDING", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    let resolveCeremony!: (value: unknown) => void;
    ceremonyGet.mockReturnValue(
      new Promise((resolve) => {
        resolveCeremony = resolve;
      }),
    );
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    ceremonyCreate.mockResolvedValue(registrationResponse);
    mutations.finishAddPasskey.mockResolvedValue({
      success: true,
      passkeyId: "passkey-2",
    });
    const { result } = renderManagement();
    expect(result.current.add.pending).toBe(false);

    let flow!: Promise<AddPasskeyResult>;
    act(() => {
      flow = result.current.add.addPasskey();
    });
    await waitFor(() => expect(result.current.add.pending).toBe(true));

    // The second call must not disturb the pending dialog of the first.
    let second!: AddPasskeyResult;
    await act(async () => {
      second = await result.current.add.addPasskey();
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(mutations.startAddPasskey).toHaveBeenCalledTimes(1);

    // The first call still completes normally.
    let firstResult!: AddPasskeyResult;
    await act(async () => {
      resolveCeremony(authenticationResponse);
      firstResult = await flow;
    });
    expect(firstResult).toEqual({ success: true, passkeyId: "passkey-2" });
    expect(result.current.add.pending).toBe(false);
  });

  test("the callbacks keep one identity across re-renders", async () => {
    const { result, rerender } = renderManagement();
    const first = result.current;
    rerender();
    expect(result.current.add.addPasskey).toBe(first.add.addPasskey);
    expect(result.current.remove.removePasskey).toBe(
      first.remove.removePasskey,
    );
  });
});

describe("useRemovePasskey", () => {
  test("runs the assertion and sends the target with it", async () => {
    mutations.startRemovePasskey.mockResolvedValue(removeStart);
    ceremonyGet.mockResolvedValue(authenticationResponse);
    mutations.finishRemovePasskey.mockResolvedValue({ success: true });
    const { result } = renderManagement();

    let returned!: RemovePasskeyResult;
    await act(async () => {
      returned = await result.current.remove.removePasskey("passkey-1");
    });

    expect(callOrder).toEqual([
      "startRemovePasskey",
      "get",
      "finishRemovePasskey",
    ]);
    expect(mutations.startRemovePasskey).toHaveBeenCalledWith({
      passkeyId: "passkey-1",
    });
    expect(ceremonyGet).toHaveBeenCalledWith({
      optionsJSON: requestOptions,
    });
    expect(mutations.finishRemovePasskey).toHaveBeenCalledWith({
      passkeyId: "passkey-1",
      response: authenticationResponse,
    });
    expect(returned).toEqual({ success: true });
  });

  test("a server userError passes through without a ceremony", async () => {
    const failure = { success: false, userError: { error: "LAST_PASSKEY" } };
    mutations.startRemovePasskey.mockResolvedValue(failure);
    const { result } = renderManagement();

    let returned!: RemovePasskeyResult;
    await act(async () => {
      returned = await result.current.remove.removePasskey("passkey-1");
    });

    expect(returned).toEqual(failure);
    expect(ceremonyGet).not.toHaveBeenCalled();
    expect(mutations.finishRemovePasskey).not.toHaveBeenCalled();
  });

  test("no WebAuthn support stops the flow before the first mutation", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    const { result } = renderManagement();

    let returned!: RemovePasskeyResult;
    await act(async () => {
      returned = await result.current.remove.removePasskey("passkey-1");
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(mutations.startRemovePasskey).not.toHaveBeenCalled();
  });

  test("each hook instance tracks its own pending state", async () => {
    mutations.startRemovePasskey.mockResolvedValue(removeStart);
    let resolveCeremony!: (value: unknown) => void;
    ceremonyGet.mockReturnValue(
      new Promise((resolve) => {
        resolveCeremony = resolve;
      }),
    );
    mutations.finishRemovePasskey.mockResolvedValue({ success: true });
    // Two rows of a passkey list, each with its own remove hook.
    const { result } = renderHook(
      () => ({
        row1: useRemovePasskey(managementApi()),
        row2: useRemovePasskey(managementApi()),
      }),
      { wrapper },
    );

    let flow!: Promise<RemovePasskeyResult>;
    act(() => {
      flow = result.current.row1.removePasskey("passkey-1");
    });
    await waitFor(() => expect(result.current.row1.pending).toBe(true));
    // The other row's spinner stays off.
    expect(result.current.row2.pending).toBe(false);

    await act(async () => {
      resolveCeremony(authenticationResponse);
      await flow;
    });
    expect(result.current.row1.pending).toBe(false);
  });

  test("a cancelled dialog folds into CEREMONY_ABORTED", async () => {
    mutations.startRemovePasskey.mockResolvedValue(removeStart);
    ceremonyGet.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderManagement();

    let returned!: RemovePasskeyResult;
    await act(async () => {
      returned = await result.current.remove.removePasskey("passkey-1");
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(mutations.finishRemovePasskey).not.toHaveBeenCalled();
    expect(result.current.remove.pending).toBe(false);
  });
});
