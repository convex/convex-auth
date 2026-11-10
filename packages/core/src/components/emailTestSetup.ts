import {
  convexTest,
  type TestConvex,
  type TestConvexForDataModel,
} from "convex-test";
import type { DataModelFromSchemaDefinition } from "convex/server";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import schema from "./email/schema.ts";
import { normalizeEmail } from "./email/validation.ts";
import { emailByNormalizedEmail } from "./email/helpers.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { registerAttestationSigner } from "../lib/attestationSigner.fixture.ts";
import {
  CURRENT_USER_ATTESTATION,
  NEW_USER_ATTESTATION,
  USER_ATTESTATION,
} from "../lib/attestationKinds.ts";

export const modules = import.meta.glob("./email/**/*.ts");

type Signers = {
  /** Signs as the core (`auth`). */
  core: ReturnType<typeof registerAttestationSigner>;
  /** Signs as a component that verified a user (`authPassword`). */
  verifier: ReturnType<typeof registerAttestationSigner>;
};

const signers = new WeakMap<object, Signers>();

/**
 * Make a test instance of the component. The component mounts the batch
 * worker (the cleanup loop) and the rate limiter (the `start` throttle), so
 * register both with the test instance too.
 *
 * The function also registers the test signers of the attestations. Register
 * every component before the test runs a function: convex-test does not add
 * a component that it registers later to a transaction that is open, for
 * example a function of the cleanup loop that runs in the background.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  registerBatchWorker(t);
  registerRateLimiter(t);
  signers.set(t, {
    core: registerAttestationSigner(t, "auth"),
    verifier: registerAttestationSigner(t, "authPassword"),
  });
  return t;
}

function signersOf(t: object): Signers {
  const found = signers.get(t);
  if (found === undefined) {
    throw new Error("Make the test instance with `setup`.");
  }
  return found;
}

/** A new-user attestation of the core for `userId`. */
export async function newUserAttestation(
  t: object,
  userId: string,
): Promise<string> {
  return await signersOf(t).core.attest(NEW_USER_ATTESTATION, { userId });
}

/**
 * A user attestation for `userId`, as if a different component verified the
 * user (for example the password component with the current password).
 */
export async function userAttestation(
  t: object,
  userId: string,
): Promise<string> {
  return await signersOf(t).verifier.attest(USER_ATTESTATION, { userId });
}

/** A test instance, with or without request metadata. */
export type TestClient = TestConvexForDataModel<
  DataModelFromSchemaDefinition<typeof schema>
>;

/** The client IP of the test requests. */
const IP = "203.0.113.7";

/**
 * Make a test instance of the component that sends its requests from `IP`.
 * Use it for the functions that rate-limit per client IP.
 */
export function setupClient(): TestClient {
  return setup().withRequestMetadata({ ip: IP });
}

/** Seed a verified email row directly; the challenge arrives later. */
export async function seedEmail(
  t: TestClient,
  userId: string,
  email: string,
  isPrimary: boolean,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: normalizeEmail(email),
      userId,
      isPrimary,
    });
  });
}

/**
 * Read the verified row for an address directly, without the rate limit of
 * `lookupEmail`. The lookup ignores the case, like `lookupEmail`.
 */
export async function verifiedEmailRow(
  t: TestClient,
  email: string,
): Promise<{ userId: string; email: string } | null> {
  return await t.run(async (ctx) => {
    const row = await emailByNormalizedEmail(ctx, normalizeEmail(email));
    return row === null ? null : { userId: row.userId, email: row.email };
  });
}

export type ChallengePurposeRow =
  | { kind: "addEmail"; userId: string }
  | { kind: "changeEmail"; userId: string }
  | { kind: "signUp"; userId: string }
  | { kind: "custom"; userId?: string; purpose: string };

/**
 * Seed a pending challenge row directly, with the hashes of the code and the
 * secret.
 */
export async function seedChallenge(
  t: TestClient,
  args: {
    email: string;
    purpose: ChallengePurposeRow;
    emailCode: string;
    browserSecret: string;
    expiresAt?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      purpose: args.purpose,
      emailCodeHash: await sha256Hex(args.emailCode),
      browserSecretHash: await sha256Hex(args.browserSecret),
      expiresAt: args.expiresAt ?? Date.now() + 60_000,
    });
  });
}

/** A current-user attestation of the core for `userId`. */
export async function currentUser(t: object, userId: string): Promise<string> {
  return await signersOf(t).core.attest(CURRENT_USER_ATTESTATION, { userId });
}
