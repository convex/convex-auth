// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  authenticate,
  authenticateWithAutofill,
  foldClientError,
  register,
  supportsWebAuthn,
} from "./client.ts";
import { fromBase64URL, toBase64URL } from "./base64url.ts";

// The ceremonies run through `@simplewebauthn/browser`; the tests mock its
// module surface and check what the wrappers add on top: the support
// check, the error fold, and the pruning of the response.
const startRegistration = vi.fn();
const startAuthentication = vi.fn();

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: (...args: unknown[]) => startRegistration(...args),
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
}));

class FakePublicKeyCredential {}

// A registration response as the library returns it, with the convenience
// fields that the wire must not carry.
const registrationResponse = {
  id: "credential-id",
  rawId: "credential-id",
  response: {
    clientDataJSON: "client-data",
    attestationObject: "attestation",
    transports: ["internal", "hybrid"],
    authenticatorData: "auth-data",
    publicKey: "public-key",
    publicKeyAlgorithm: -7,
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: { credProps: { rk: true } },
  type: "public-key",
};

// An authentication response as the library returns it.
const authenticationResponse = {
  id: "credential-id",
  rawId: "credential-id",
  response: {
    clientDataJSON: "client-data",
    authenticatorData: "auth-data",
    signature: "signature",
    userHandle: "user-handle",
  },
  authenticatorAttachment: "platform",
  clientExtensionResults: {},
  type: "public-key",
};

const creationOptions = {
  rp: { id: "localhost", name: "Test app" },
  user: { id: "handle", name: "alice", displayName: "alice" },
  challenge: "challenge",
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

/**
 * base64url of a short ASCII string. The conditional path decodes the
 * challenge it is given, so the fixtures have to be real base64url.
 */
const wire = (text: string) =>
  toBase64URL(
    Uint8Array.from(text, (character) => character.charCodeAt(0)).buffer,
  );

const requestOptions = {
  challenge: wire("challenge"),
  timeout: 600000,
  rpId: "localhost",
  allowCredentials: [],
  userVerification: "required" as const,
};

/** An error the way `WebAuthnError` wraps it: the `name` is preserved. */
function browserError(name: string) {
  const error = new Error(`wrapped ${name}`);
  error.name = name;
  return error;
}

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("isSecureContext", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  startRegistration.mockReset();
  startAuthentication.mockReset();
});

describe("supportsWebAuthn", () => {
  test("true with PublicKeyCredential in a secure context", () => {
    expect(supportsWebAuthn()).toBe(true);
  });

  test("false without PublicKeyCredential", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(supportsWebAuthn()).toBe(false);
  });

  test("false outside a secure context", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(supportsWebAuthn()).toBe(false);
  });
});

describe("foldClientError", () => {
  test("NotAllowedError folds into CEREMONY_ABORTED", () => {
    expect(
      foldClientError(new DOMException("cancelled", "NotAllowedError")),
    ).toEqual({ error: "CEREMONY_ABORTED" });
  });

  test("AbortError folds into CEREMONY_ABORTED", () => {
    expect(foldClientError(new DOMException("aborted", "AbortError"))).toEqual({
      error: "CEREMONY_ABORTED",
    });
  });

  test("a wrapped WebAuthnError folds by its preserved name", () => {
    expect(foldClientError(browserError("NotAllowedError"))).toEqual({
      error: "CEREMONY_ABORTED",
    });
  });

  test("InvalidStateError folds into OTHER_ERROR outside a registration", () => {
    const cause = browserError("InvalidStateError");
    expect(foldClientError(cause)).toEqual({ error: "OTHER_ERROR", cause });
  });

  test("everything else folds into OTHER_ERROR with the cause", () => {
    const cause = new Error("network blip");
    expect(foldClientError(cause)).toEqual({ error: "OTHER_ERROR", cause });
  });
});

describe("register", () => {
  it("hands the options to startRegistration and prunes the response", async () => {
    startRegistration.mockResolvedValue(registrationResponse);

    const result = await register(creationOptions);

    expect(startRegistration).toHaveBeenCalledWith({
      optionsJSON: creationOptions,
    });
    // Some of the fields (e.g. `publicKey`, `publicKeyAlgorithm`,
    // `authenticatorData`, `authenticatorAttachment`) are not used
    // on the server, so it’s expected that we strip them before
    // calling the server function.
    expect(result).toEqual({
      success: true,
      response: {
        id: "credential-id",
        rawId: "credential-id",
        response: {
          clientDataJSON: "client-data",
          attestationObject: "attestation",
          transports: ["internal", "hybrid"],
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  test("`transports` is undefined in the `register` output when using a browser that doesn’t support `transports`", async () => {
    startRegistration.mockResolvedValue({
      ...registrationResponse,
      response: {
        clientDataJSON: "client-data",
        attestationObject: "attestation",
      },
    });
    const result = await register(creationOptions);
    expect(result.success).toBe(true);
    expect(result.success && result.response.response).not.toHaveProperty(
      "transports",
    );
  });

  test("a thrown NotAllowedError folds into CEREMONY_ABORTED", async () => {
    startRegistration.mockRejectedValue(browserError("NotAllowedError"));
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("an excluded credential folds into PASSKEY_ALREADY_REGISTERED", async () => {
    startRegistration.mockRejectedValue(browserError("InvalidStateError"));
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "PASSKEY_ALREADY_REGISTERED" },
    });
  });

  test("an unexpected throw folds into OTHER_ERROR with the cause", async () => {
    const cause = new Error("boom");
    startRegistration.mockRejectedValue(cause);
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(startRegistration).not.toHaveBeenCalled();
  });
});

describe("authenticate", () => {
  it("hands the options to startAuthentication and prunes the response", async () => {
    startAuthentication.mockResolvedValue(authenticationResponse);

    const result = await authenticate(requestOptions);

    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: requestOptions,
    });
    expect(result).toEqual({
      success: true,
      response: {
        id: "credential-id",
        rawId: "credential-id",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "auth-data",
          signature: "signature",
          userHandle: "user-handle",
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  it("doesn’t include userHandle in the return value when the authenticator doesn’t set it", async () => {
    startAuthentication.mockResolvedValue({
      ...authenticationResponse,
      response: {
        clientDataJSON: "client-data",
        authenticatorData: "auth-data",
        signature: "signature",
      },
    });
    const result = await authenticate(requestOptions);
    expect(result.success).toBe(true);
    expect(result.success && result.response.response).not.toHaveProperty(
      "userHandle",
    );
  });

  test("an aborted ceremony folds into CEREMONY_ABORTED", async () => {
    startAuthentication.mockRejectedValue(browserError("AbortError"));
    expect(await authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("an InvalidStateError is not a duplicate registration", async () => {
    const cause = browserError("InvalidStateError");
    startAuthentication.mockRejectedValue(cause);
    expect(await authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(startAuthentication).not.toHaveBeenCalled();
  });
});

describe("authenticateWithAutofill", () => {
  // The conditional path calls `navigator.credentials.get` itself, so that
  // the caller can own the `AbortSignal`; see the comment on the function.
  const credentialsGet = vi.fn();

  function stubCredentials() {
    vi.stubGlobal("navigator", { credentials: { get: credentialsGet } });
  }

  /** A `PublicKeyCredential` the way the browser returns one. */
  function assertion({ userHandle }: { userHandle: ArrayBuffer | null }) {
    return {
      id: wire("credential-id"),
      rawId: fromBase64URL(wire("credential-id")),
      response: {
        clientDataJSON: fromBase64URL(wire("client-data")),
        authenticatorData: fromBase64URL(wire("auth-data")),
        signature: fromBase64URL(wire("signature")),
        userHandle,
      },
      type: "public-key",
    };
  }

  afterEach(() => {
    credentialsGet.mockReset();
  });

  test("asks for a conditional request with the caller's signal", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(assertion({ userHandle: null }));
    const controller = new AbortController();

    await authenticateWithAutofill(requestOptions, controller.signal);

    expect(credentialsGet).toHaveBeenCalledTimes(1);
    const options = credentialsGet.mock.calls[0][0];
    expect(options.mediation).toBe("conditional");
    expect(options.signal).toBe(controller.signal);
    // Conditional mediation requires an empty allow-list.
    expect(options.publicKey.allowCredentials).toEqual([]);
    expect(options.publicKey.rpId).toBe(requestOptions.rpId);
    expect(options.publicKey.timeout).toBe(requestOptions.timeout);
    expect(options.publicKey.userVerification).toBe("required");
    expect(toBase64URL(options.publicKey.challenge)).toBe(
      requestOptions.challenge,
    );
  });

  test("puts the assertion into the wire shape", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(
      assertion({ userHandle: fromBase64URL(wire("user-handle")) }),
    );

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({
      success: true,
      response: {
        id: wire("credential-id"),
        rawId: wire("credential-id"),
        response: {
          clientDataJSON: wire("client-data"),
          authenticatorData: wire("auth-data"),
          signature: wire("signature"),
          userHandle: wire("user-handle"),
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  test("a discoverable assertion without a user handle carries none", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(assertion({ userHandle: null }));

    const result = await authenticateWithAutofill(
      requestOptions,
      new AbortController().signal,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.response.response).not.toHaveProperty(
      "userHandle",
    );
  });

  test("an abort folds into CEREMONY_ABORTED", async () => {
    stubCredentials();
    credentialsGet.mockRejectedValue(browserError("AbortError"));

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "CEREMONY_ABORTED" } });
  });

  test("a null credential folds into CEREMONY_ABORTED", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(null);

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "CEREMONY_ABORTED" } });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    stubCredentials();
    vi.stubGlobal("PublicKeyCredential", undefined);

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } });
    expect(credentialsGet).not.toHaveBeenCalled();
  });
});
