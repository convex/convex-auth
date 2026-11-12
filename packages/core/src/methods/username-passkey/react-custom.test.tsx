// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { anyApi, getFunctionName, type FunctionReference } from "convex/server";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { AuthSignInApi } from "../../react/client.tsx";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import {
  createUsernamePasskeyHooks,
  type AddPasskeyApi,
  type PasskeyCeremonies,
  type UsernamePasskeyApi,
} from "./react-custom.tsx";

// jsdom has no `PublicKeyCredential`, so a passing ceremony here can only
// come from the app's ceremonies below, not from the browser ones.

const mutations = {
  startSignInWithUsernamePasskey: vi.fn(),
  finishSignUpWithUsernamePasskey: vi.fn(),
  startAutofillSignInWithUsernamePasskey: vi.fn(),
  startAddPasskey: vi.fn(),
  verifyAddPasskey: vi.fn(),
  finishAddPasskey: vi.fn(),
};
const runMutation = (fn: FunctionReference<"mutation">, args: unknown) =>
  mutations[getFunctionName(fn).split(":")[1] as keyof typeof mutations](args);
const signInApi = { mutation: runMutation } as unknown as AuthSignInApi;
const convexClient = { mutation: runMutation } as unknown as ConvexReactClient;
const api = () => anyApi.auth as unknown as UsernamePasskeyApi & AddPasskeyApi;

const ceremonies = {
  isSupported: () => true,
  register: vi.fn<PasskeyCeremonies["register"]>(),
  authenticate: vi.fn<PasskeyCeremonies["authenticate"]>(),
};
const hooks = createUsernamePasskeyHooks(ceremonies);

const registration = {
  id: "cred-1",
  rawId: "cred-1",
  response: { clientDataJSON: "client-data", attestationObject: "att" },
  type: "public-key" as const,
};
const authentication = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "auth-data",
    signature: "signature",
  },
  type: "public-key" as const,
};
const wire = <T,>(response: T) => ({ ...response, clientExtensionResults: {} });

afterEach(() => {
  for (const mock of Object.values(mutations)) mock.mockReset();
  ceremonies.register.mockReset();
  ceremonies.authenticate.mockReset();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: "https://happy-animal-123.convex.cloud",
  });
  return (
    <AuthProvider authClient={client} signInApi={signInApi}>
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    </AuthProvider>
  );
}

describe("createUsernamePasskeyHooks", () => {
  test("useSignInWithUsernamePasskey runs the app's ceremonies", async () => {
    const options = { challenge: "challenge-1" };
    mutations.startSignInWithUsernamePasskey.mockResolvedValue({
      success: true,
      step: "register",
      options,
    });
    ceremonies.register.mockResolvedValue({
      success: true,
      response: registration,
    });
    mutations.finishSignUpWithUsernamePasskey.mockResolvedValue({
      status: "complete",
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        refreshTokenExpiresAt: 0,
        userId: "user-1",
      },
    });
    const { result } = renderHook(
      () => ({
        auth: useAuth(),
        passkey: hooks.useSignInWithUsernamePasskey(api()),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.passkey.signIn({ username: "alice" });
    });

    expect(ceremonies.register).toHaveBeenCalledWith(options);
    expect(mutations.finishSignUpWithUsernamePasskey).toHaveBeenCalledWith({
      username: "alice",
      response: wire(registration),
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    // The ceremonies have no `autofill`.
    expect(result.current.passkey.autofill).toEqual({
      available: false,
      status: "stopped",
      lastError: null,
    });
  });

  test("useAddPasskey runs the app's ceremonies", async () => {
    mutations.startAddPasskey.mockResolvedValue({ success: true, options: {} });
    ceremonies.authenticate.mockResolvedValue({
      success: true,
      response: authentication,
    });
    mutations.verifyAddPasskey.mockResolvedValue({
      success: true,
      options: {},
    });
    ceremonies.register.mockResolvedValue({
      success: true,
      response: registration,
    });
    mutations.finishAddPasskey.mockResolvedValue({ success: true });
    const { result } = renderHook(() => hooks.useAddPasskey(api()), {
      wrapper,
    });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.addPasskey();
    });

    expect(mutations.verifyAddPasskey).toHaveBeenCalledWith({
      response: wire(authentication),
    });
    expect(mutations.finishAddPasskey).toHaveBeenCalledWith({
      response: wire(registration),
    });
    expect(returned).toEqual({ success: true });
  });
});
