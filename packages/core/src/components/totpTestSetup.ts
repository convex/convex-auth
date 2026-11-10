import { convexTest, type TestConvex } from "convex-test";
import { registerAttestationSigner } from "../lib/attestationSigner.fixture.ts";
import { CURRENT_USER_ATTESTATION } from "../lib/attestationKinds.ts";
import { afterEach, beforeEach, vi } from "vitest";
import { api } from "./totp/_generated/api.ts";
import schema from "./totp/schema.ts";
import { DEFAULT_PERIOD, totp } from "./totp/totp.ts";

export const modules = import.meta.glob("./totp/**/*.ts");

export const PERIOD_MS = DEFAULT_PERIOD * 1000;
// A moment in the middle of a time step, so that a few milliseconds of test
// time never cross a step boundary.
export const START = 1_700_000_015_000;
export const ENROLLMENT = {
  issuerDisplayName: "Acme",
  accountDisplayName: "alice@example.com",
};

const coreSigners = new WeakMap<
  object,
  ReturnType<typeof registerAttestationSigner>
>();

/**
 * Make a test instance of the component, with the test signer of the core
 * (`auth`). Register every component before the test runs a function:
 * convex-test does not add a component that it registers later to a
 * transaction that is open.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  coreSigners.set(t, registerAttestationSigner(t, "auth"));
  return t;
}

/**
 * Let the tests of the calling file control the clock: the codes depend on
 * the time. Only `Date` is faked, because convex-test uses the real timers.
 */
export function controlClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/** The code an authenticator app shows for the secret, at the given time. */
export function codeFor(
  secret: string,
  atMs: number = Date.now(),
): Promise<string> {
  return totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, atMs);
}

/**
 * Enroll a user's first authenticator, and move the clock one step forward:
 * the code that confirms the secret cannot be used again, thus a test that
 * verifies a code right after the enrollment needs the code of a later step.
 */
export async function enroll(
  t: TestConvex<typeof schema>,
  userId: string = "alice",
): Promise<{ secret: string; totpId: string; backupCodes: string[] }> {
  const { secret, totpId, backupCodes } = await addAuthenticator(t, userId);
  if (backupCodes === undefined) {
    throw new Error(`${userId} was enrolled already.`);
  }
  return { secret, totpId, backupCodes };
}

/**
 * Enroll one more authenticator for a user with `confirmTotp`, and move the
 * clock one step forward, as {@link enroll} does. The backup codes come back
 * only for the user's first authenticator.
 */
export async function addAuthenticator(
  t: TestConvex<typeof schema>,
  userId: string = "alice",
): Promise<{ secret: string; totpId: string; backupCodes?: string[] }> {
  const { secret } = await t.mutation(api.enrollment.createTotp, {
    currentUser: await currentUser(t, userId),
    ...ENROLLMENT,
  });
  const result = await t.mutation(api.enrollment.confirmTotp, {
    currentUser: await currentUser(t, userId),
    code: await codeFor(secret),
  });
  if (!result.success) {
    throw new Error(`Enrollment failed: ${JSON.stringify(result)}`);
  }
  advance(PERIOD_MS);
  return {
    secret,
    totpId: result.totpId,
    backupCodes: result.backupCodes,
  };
}

/** A current-user attestation of the core for `userId`. */
export async function currentUser(t: object, userId: string): Promise<string> {
  const signer = coreSigners.get(t);
  if (signer === undefined) {
    throw new Error("Make the test instance with `setup`.");
  }
  return await signer.attest(CURRENT_USER_ATTESTATION, { userId });
}
