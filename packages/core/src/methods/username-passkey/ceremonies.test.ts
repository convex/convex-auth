import { describe, expect, test } from "vitest";
import { resolveCeremonies, type PasskeyCeremonies } from "./ceremonies.ts";

const creationOptions = {} as Parameters<PasskeyCeremonies["register"]>[0];
const requestOptions = {} as Parameters<PasskeyCeremonies["authenticate"]>[0];

// What a passkey library returns: convenience fields that the server refuses,
// and `null` for missing optional fields.
const libraryRegistration = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: null,
    publicKey: "public-key",
  },
  authenticatorAttachment: "platform",
  type: "public-key" as const,
};

const libraryAuthentication = {
  id: "cred-1",
  rawId: "cred-1",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "auth-data",
    signature: "signature",
    userHandle: null,
  },
  clientExtensionResults: { credProps: { rk: true } },
  type: "public-key" as const,
};

function makeCeremonies(
  overrides: Partial<PasskeyCeremonies> = {},
): PasskeyCeremonies {
  return {
    isSupported: () => true,
    register: async () => ({ success: true, response: libraryRegistration }),
    authenticate: async () => ({
      success: true,
      response: libraryAuthentication,
    }),
    ...overrides,
  };
}

function namedError(name: string) {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("resolveCeremonies", () => {
  test("prunes the responses to the wire shape", async () => {
    const resolved = resolveCeremonies(makeCeremonies());

    expect(await resolved.register(creationOptions)).toEqual({
      success: true,
      response: {
        id: "cred-1",
        rawId: "cred-1",
        response: {
          clientDataJSON: "client-data",
          attestationObject: "attestation",
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
    expect(await resolved.authenticate(requestOptions)).toEqual({
      success: true,
      response: {
        id: "cred-1",
        rawId: "cred-1",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "auth-data",
          signature: "signature",
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  test("passes a returned failure through", async () => {
    const failure = {
      success: false as const,
      userError: { error: "PASSKEY_ALREADY_REGISTERED" as const },
    };
    const resolved = resolveCeremonies(
      makeCeremonies({ register: async () => failure }),
    );

    expect(await resolved.register(creationOptions)).toEqual(failure);
  });

  test("folds a thrown value into a userError", async () => {
    const cause = new Error("native module crashed");
    const resolved = resolveCeremonies(
      makeCeremonies({
        register: async () => {
          throw namedError("NotAllowedError");
        },
        authenticate: () => {
          throw cause;
        },
        isSupported: () => {
          throw cause;
        },
      }),
    );

    expect(await resolved.register(creationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(await resolved.authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(resolved.isSupported()).toBe(false);
  });

  test("without autofill, autofill is unavailable", async () => {
    const resolved = resolveCeremonies(makeCeremonies());

    expect(await resolved.isAutofillAvailable()).toBe(false);
    expect(
      await resolved.authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } });
    expect(() => resolved.onResume(() => {})()).not.toThrow();
  });
});
