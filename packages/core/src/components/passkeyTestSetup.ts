import { convexTest, type TestConvex } from "convex-test";
import { expect, vi } from "vitest";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import {
  ORIGIN,
  RP_ID,
  buildAttestationObject,
  buildAuthenticatorData,
  buildClientDataJSON,
  generateES256Credential,
  registrationResponse,
  type TestCredential,
} from "@convex-dev/passkey-test-authenticator";
import { api } from "./passkey/_generated/api.ts";
import schema from "./passkey/schema.ts";
import { registerAttestationSigner } from "../lib/attestationSigner.fixture.ts";
import { NEW_USER_ATTESTATION } from "../lib/attestationKinds.ts";

export const modules = import.meta.glob("./passkey/**/*.ts");

const coreSigners = new WeakMap<
  object,
  ReturnType<typeof registerAttestationSigner>
>();

/**
 * Make a test instance of the component. The component mounts the batch
 * worker (the ceremony mutations ping the cleanup loop), so register it
 * with the test instance too.
 *
 * The function also registers the test signer of the core (`auth`). Register
 * every component before the test runs a function: convex-test does not add
 * a component that it registers later to a transaction that is open, for
 * example a function of the cleanup loop that runs in the background.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  registerBatchWorker(t);
  coreSigners.set(t, registerAttestationSigner(t, "auth"));
  return t;
}

/** A new-user attestation of the core for `userId`. */
export async function newUserAttestation(
  t: object,
  userId: string,
): Promise<string> {
  const signer = coreSigners.get(t);
  if (signer === undefined) {
    throw new Error("Make the test instance with `setup`.");
  }
  return await signer.attest(NEW_USER_ATTESTATION, { userId });
}

/** Assert that two byte buffers hold the same bytes. */
export function expectSameBytes(
  a: ArrayBuffer | Uint8Array,
  b: ArrayBuffer | Uint8Array,
): void {
  expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
}

/**
 * Assert that a ceremony call rejects a client that does not respect the
 * WebAuthn protocol: the client gets `PROTOCOL_ERROR` and nothing else, and
 * the backend logs carry `detail`.
 */
export async function expectProtocolError(
  call: () => Promise<unknown>,
  detail: string,
): Promise<void> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(call()).resolves.toEqual({
      success: false,
      userError: { error: "PROTOCOL_ERROR" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(detail));
  } finally {
    warn.mockRestore();
  }
}

/** Run a full registration ceremony and return the stored credential. */
export async function register(
  t: TestConvex<typeof schema>,
  userId: string,
  options: {
    name?: string;
    credential?: TestCredential;
    counter?: number;
    transports?: string[];
  } = {},
): Promise<{ credential: TestCredential; passkeyId: string }> {
  const credential = options.credential ?? (await generateES256Credential());
  const { challenge } = await t.mutation(
    api.registration.startRegistrationForExistingUser,
    { verifiedUserId: userId },
  );
  const authData = await buildAuthenticatorData({
    rpId: RP_ID,
    counter: options.counter ?? 0,
    credential,
  });
  const result = await t.mutation(
    api.registration.finishRegistrationForExistingUser,
    {
      expectedRpId: RP_ID,
      expectedOrigin: ORIGIN,
      verifiedUserId: userId,
      name: options.name,
      response: registrationResponse({
        credential,
        attestationObject: buildAttestationObject(authData),
        clientDataJSON: buildClientDataJSON({
          type: "webauthn.create",
          challenge,
          origin: ORIGIN,
        }),
        transports: options.transports,
      }),
    },
  );
  if (!result.success) {
    throw new Error(`Test registration failed: ${result.userError.error}`);
  }
  return { credential, passkeyId: result.passkeyId };
}
