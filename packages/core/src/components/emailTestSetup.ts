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

export const modules = import.meta.glob("./email/**/*.ts");

/**
 * Make a test instance of the component. The component mounts the batch
 * worker (the cleanup loop) and the rate limiter (the `start` throttle), so
 * register both with the test instance too.
 */
export function setup(): TestConvex<typeof schema> {
  const t = convexTest(schema, modules);
  registerBatchWorker(t);
  registerRateLimiter(t);
  return t;
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
  | { kind: "signIn" }
  | { kind: "custom"; userId?: string; purpose: string };

/**
 * Seed a pending challenge row directly, with the hashes of the code and the
 * secret. Give `attemptsLeft` for a challenge that sends a short code.
 */
export async function seedChallenge(
  t: TestClient,
  args: {
    email: string;
    purpose: ChallengePurposeRow;
    emailCode: string;
    browserSecret: string;
    expiresAt?: number;
    attemptsLeft?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      purpose: args.purpose,
      emailCodeHash: await sha256Hex(args.emailCode),
      browserSecretHash: await sha256Hex(args.browserSecret),
      expiresAt: args.expiresAt ?? Date.now() + 60_000,
      ...(args.attemptsLeft === undefined
        ? {}
        : { attemptsLeft: args.attemptsLeft }),
    });
  });
}
