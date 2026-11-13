import { describe, expect, test } from "vitest";
import {
  RP_ID,
  aaguidBytes,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  registrationResponse,
  toBase64URL,
} from "@convex-dev/passkey-test-authenticator";
import { defaultPasskeyName } from "./aaguids.ts";
import type { WireRegistrationResponse } from "../../components/passkey/validation.ts";

/** The response of a `create()` ceremony that reports `aaguid`. */
async function response(options: {
  aaguid?: Uint8Array;
  includeCredential?: boolean;
}): Promise<WireRegistrationResponse> {
  const credential = await generateES256Credential();
  return registrationResponse({
    credential,
    attestationObject: buildAttestationObject(
      await buildAuthenticatorData({
        rpId: RP_ID,
        credential:
          options.includeCredential === false ? undefined : credential,
        aaguid: options.aaguid,
      }),
    ),
    clientDataJSON: buildClientDataJSON({
      type: "webauthn.create",
      challenge: toBase64URL(new ArrayBuffer(32)),
      origin: "https://app.example.com",
    }),
  });
}

describe("defaultPasskeyName", () => {
  test("names a well-known authenticator", async () => {
    const apple = aaguidBytes("fbfc3007-154e-4ecc-8c0b-6e020557d7bd");
    expect(defaultPasskeyName(await response({ aaguid: apple }))).toBe(
      "Apple Passwords",
    );
  });

  test("gives no name for an unknown AAGUID", async () => {
    // `attestation: "none"` lets an authenticator zero its AAGUID; the big
    // passkey providers report theirs anyway.
    expect(defaultPasskeyName(await response({}))).toBeUndefined();
  });

  test("gives no name when the attestation carries no credential data", async () => {
    expect(
      defaultPasskeyName(await response({ includeCredential: false })),
    ).toBeUndefined();
  });

  test("gives no name for an attestation that does not parse", async () => {
    const unreadable = await response({});
    unreadable.response.attestationObject = "not an attestation object";
    expect(defaultPasskeyName(unreadable)).toBeUndefined();
  });
});
