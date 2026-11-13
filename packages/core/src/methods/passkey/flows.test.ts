/**
 * The client flows of the `passkey` method, on a fake Convex client and fake
 * ceremonies.
 */
import type { ConvexReactClient } from "convex/react";
import { anyApi, getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { ResolvedPasskeyCeremonies } from "../username-passkey/ceremonies.ts";
import {
  runAddPasskeyFlow,
  runSignInWithPasskeyFlow,
  type AddPasskeyApi,
  type PasskeySignInApi,
} from "./flows.ts";

const requestOptions = { challenge: "challenge-1", rpId: "localhost" };
const creationOptions = { challenge: "challenge-2" };
const assertion = { id: "cred-1", rawId: "cred-1", type: "public-key" };
const attestation = { id: "cred-2", rawId: "cred-2", type: "public-key" };
const tokens = { token: "jwt", refreshToken: "refresh" };

function fakeCeremonies(
  overrides: Partial<ResolvedPasskeyCeremonies> = {},
): ResolvedPasskeyCeremonies {
  return {
    isSupported: () => true,
    register: vi.fn(async () => ({
      success: true as const,
      response: attestation as never,
    })),
    authenticate: vi.fn(async () => ({
      success: true as const,
      response: assertion as never,
    })),
    isAutofillAvailable: async () => false,
    authenticateWithAutofill: vi.fn(),
    onResume: () => () => {},
    ...overrides,
  };
}

function signInSetup(finishResult: unknown) {
  const mutation = vi.fn(
    async (_fn: PasskeySignInApi["startSignInWithPasskey"], _args: object) => ({
      options: requestOptions,
    }),
  );
  const signInMutation = vi.fn(
    async (_fn: PasskeySignInApi["finishSignInWithPasskey"], _args: object) =>
      finishResult,
  );
  const setSession = vi.fn(async () => {});
  const ceremonies = fakeCeremonies();
  const ctx = {
    convex: { mutation } as unknown as ConvexReactClient,
    api: anyApi.passkey as unknown as PasskeySignInApi,
    signInApi: { mutation: signInMutation } as unknown as AuthSignInApi,
    setSession,
    ceremonies,
  };
  return { ctx, mutation, signInMutation, setSession, ceremonies };
}

describe("runSignInWithPasskeyFlow", () => {
  test("asks for any passkey and stores the session", async () => {
    const { ctx, mutation, signInMutation, setSession, ceremonies } =
      signInSetup({ status: "complete", tokens });

    const result = await runSignInWithPasskeyFlow(ctx);

    expect(result).toEqual({ status: "complete", tokens });
    expect(getFunctionName(mutation.mock.calls[0][0])).toBe(
      "passkey:startSignInWithPasskey",
    );
    expect(ceremonies.authenticate).toHaveBeenCalledWith(requestOptions);
    const [finishFn, finishArgs] = signInMutation.mock.calls[0];
    expect(getFunctionName(finishFn)).toBe("passkey:finishSignInWithPasskey");
    expect(finishArgs).toEqual({ response: assertion });
    expect(setSession).toHaveBeenCalledWith(tokens);
  });

  test("stores no session when the server refuses the passkey", async () => {
    const refused = {
      status: "error",
      userError: { error: "UNKNOWN_CREDENTIAL" },
    };
    const { ctx, setSession } = signInSetup(refused);

    expect(await runSignInWithPasskeyFlow(ctx)).toEqual(refused);
    expect(setSession).not.toHaveBeenCalled();
  });

  test("stops before the server when the user dismisses the dialog", async () => {
    const { ctx, signInMutation } = signInSetup(null);
    ctx.ceremonies = fakeCeremonies({
      authenticate: async () => ({
        success: false,
        userError: { error: "CEREMONY_ABORTED" },
      }),
    });

    expect(await runSignInWithPasskeyFlow(ctx)).toEqual({
      status: "error",
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(signInMutation).not.toHaveBeenCalled();
  });

  test("calls nothing when the runtime has no passkeys", async () => {
    const { ctx, mutation } = signInSetup(null);
    ctx.ceremonies = fakeCeremonies({ isSupported: () => false });

    expect(await runSignInWithPasskeyFlow(ctx)).toEqual({
      status: "error",
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(mutation).not.toHaveBeenCalled();
  });
});

describe("runAddPasskeyFlow", () => {
  function addSetup(start: unknown) {
    const mutation = vi.fn(
      async (fn: AddPasskeyApi["startAddPasskey"], _args: object) =>
        getFunctionName(fn) === "passkey:startAddPasskey"
          ? start
          : { success: true, passkeyId: "passkey-1" },
    );
    const api = anyApi.passkey as unknown as AddPasskeyApi;
    const ceremonies = fakeCeremonies();
    const ctx = {
      convex: { mutation } as unknown as ConvexReactClient,
      api,
      ceremonies,
    };
    return { ctx, mutation, ceremonies };
  }

  test("registers a passkey with the options of the server", async () => {
    const { ctx, mutation, ceremonies } = addSetup({
      success: true,
      options: creationOptions,
    });

    expect(await runAddPasskeyFlow(ctx)).toEqual({
      success: true,
      passkeyId: "passkey-1",
    });
    expect(ceremonies.register).toHaveBeenCalledWith(creationOptions);
    const [finishFn, finishArgs] = mutation.mock.calls[1];
    expect(getFunctionName(finishFn)).toBe("passkey:finishAddPasskey");
    expect(finishArgs).toEqual({ response: attestation });
  });

  test("returns REAUTHENTICATION_REQUIRED before the browser asks", async () => {
    const refused = {
      success: false,
      userError: { error: "REAUTHENTICATION_REQUIRED" },
    };
    const { ctx, mutation, ceremonies } = addSetup(refused);

    expect(await runAddPasskeyFlow(ctx)).toEqual(refused);
    expect(ceremonies.register).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});
