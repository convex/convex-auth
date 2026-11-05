import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import {
  argon2d,
  argon2i,
  argon2id,
  argon2Verify,
  bcrypt,
  bcryptVerify,
} from "hash-wasm";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { MIN_PASSWORD_LENGTH } from "./validation.ts";
import { hashPassword, verifyPassword } from "argon2id-wasm";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter; register it with the test instance
  // so `verifyPassword`'s throttle has a backing component.
  registerRateLimiter(t);
  return t;
}

describe("setPassword + verifyPassword", () => {
  test("verifies the correct password after setting it", async () => {
    const t = setup();
    const setResult = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(setResult).toEqual({ success: true });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: PASSWORD,
    });
    expect(result).toEqual({ success: true });
  });

  test("rejects a wrong password", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: "wrong horse battery staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("throws for an unknown user id", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.verifyPassword, {
        userId: "nobody",
        password: PASSWORD,
      }),
    ).rejects.toThrow();
  });

  test("upserts: setting a new password replaces the old one", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    const newPassword = "a whole new password here";
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: newPassword,
      minimumLength: MIN_PASSWORD_LENGTH,
    });

    // Only one row exists for the user.
    const count = await t.run(
      async (ctx) => (await ctx.db.query("passwords").collect()).length,
    );
    expect(count).toBe(1);

    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: newPassword,
      }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: PASSWORD,
      }),
    ).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });
});

describe("password validation (setPassword)", () => {
  test("rejects a too-short password", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "short",
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 },
    });
  });

  // The password methods require 10 characters, but the component accepts 8.
  test("accepts a password of 8 characters", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "kY7t-vQ2",
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(result).toEqual({ success: true });
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: "kY7t-vQ2",
      }),
    ).toEqual({ success: true });
  });

  test("rejects a password that is shorter than minimumLength", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "kY7t-vQ2m",
      minimumLength: 10,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  // A minimumLength of less than MIN_PASSWORD_LENGTH is an error of the caller.
  test("throws when minimumLength is less than MIN_PASSWORD_LENGTH", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.setPassword, {
        userId: "alice",
        password: "kY7t-vQ2m",
        minimumLength: 4,
      }),
    ).rejects.toThrow("minimumLength must be 8 or more");
    expect(await t.run((ctx) => ctx.db.query("passwords").collect())).toEqual(
      [],
    );
  });

  test("rejects a frequent password of 8 characters", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "12345678",
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
  });

  test("rejects a password with leading whitespace", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: " leadingspace123",
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  test("rejects one of the most frequent passwords", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "password123",
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
  });

  test("rejects a frequent password that has a different case", async () => {
    const t = setup();
    const result = await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: "Password123",
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
  });
});

describe("password validation (verifyPassword)", () => {
  test("rejects a too-short password without touching the stored password", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: "short",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 },
    });
  });

  test("rejects a too-long password", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: "a".repeat(101),
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_LONG", maximumLength: 100 },
    });
  });

  test("rejects a password with surrounding whitespace", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: " leadingspace123",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" },
    });
  });

  // A user can have a frequent password from before this rule. That user must
  // keep the possibility to log in. Only `setPassword` rejects such a password.
  test("accepts one of the most frequent passwords", async () => {
    const t = setup();
    const commonPassword = "password123";
    const passwordHashPHC = await hashPassword(commonPassword);
    await t.run(async (ctx) => {
      await ctx.db.insert("passwords", { userId: "alice", passwordHashPHC });
    });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: commonPassword,
    });
    expect(result).toEqual({ success: true });
  });
});

describe("Unicode normalization", () => {
  test("verifies across differing normalization forms", async () => {
    const t = setup();
    // "café..." spelled two ways: composed é (U+00E9) vs decomposed
    // e + combining acute (U+0301). Padded to satisfy the length requirement.
    const composed = "caf\u00e9 password test";
    const decomposed = "cafe\u0301 password test";
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));

    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: composed,
      minimumLength: MIN_PASSWORD_LENGTH,
    });
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: decomposed,
    });
    expect(result).toEqual({ success: true });
  });
});

describe("interoperability with hash-wasm", () => {
  // Must match the params baked into the Rust argon2 crate (rust/src/lib.rs).
  const ARGON2_PARAMS = {
    iterations: 3,
    parallelism: 1,
    memorySize: 16 * 1024,
    hashLength: 32,
  };

  test("hash-wasm can verify a hash produced by our crate", async () => {
    const phc = await hashPassword(PASSWORD);
    const ok = await argon2Verify({ password: PASSWORD, hash: phc });
    expect(ok).toBe(true);
  });

  test("hash-wasm rejects the wrong password against our crate's hash", async () => {
    const phc = await hashPassword(PASSWORD);
    const ok = await argon2Verify({
      password: "wrong password entirely",
      hash: phc,
    });
    expect(ok).toBe(false);
  });

  test("our crate can verify a hash produced by hash-wasm", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const phc = await argon2id({
      ...ARGON2_PARAMS,
      password: PASSWORD,
      salt,
      outputType: "encoded",
    });
    const ok = await verifyPassword(PASSWORD, phc);
    expect(ok).toBe(true);
  });

  test("our crate rejects the wrong password against hash-wasm's hash", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const phc = await argon2id({
      ...ARGON2_PARAMS,
      password: PASSWORD,
      salt,
      outputType: "encoded",
    });
    const ok = await verifyPassword("wrong password entirely", phc);
    expect(ok).toBe(false);
  });
});

describe("verifyPassword is lenient about the stored PHC string", () => {
  // verifyPassword doesn't require the stored hash to be an argon2id hash
  // produced with our own parameters: verification re-derives everything
  // (algorithm variant, version, params) from the PHC string itself, and
  // only rejects when the algorithm identifier isn't one of
  // argon2i/argon2d/argon2id at all.
  const ARGON2_PARAMS = {
    iterations: 3,
    parallelism: 1,
    memorySize: 16 * 1024,
    hashLength: 32,
  };

  test("verifies an argon2i PHC hash", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const phc = await argon2i({
      ...ARGON2_PARAMS,
      password: PASSWORD,
      salt,
      outputType: "encoded",
    });
    expect(phc.startsWith("$argon2i$")).toBe(true);
    expect(await verifyPassword(PASSWORD, phc)).toBe(true);
  });

  test("verifies an argon2d PHC hash", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const phc = await argon2d({
      ...ARGON2_PARAMS,
      password: PASSWORD,
      salt,
      outputType: "encoded",
    });
    expect(phc.startsWith("$argon2d$")).toBe(true);
    expect(await verifyPassword(PASSWORD, phc)).toBe(true);
  });

  test("verifies an argon2id PHC hash with different parameters than ours", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const phc = await argon2id({
      password: PASSWORD,
      salt,
      iterations: 2, // our crate always uses 3
      parallelism: 1,
      memorySize: 8 * 1024, // our crate always uses 16 * 1024
      hashLength: 16, // our crate always uses 32
      outputType: "encoded",
    });
    expect(await verifyPassword(PASSWORD, phc)).toBe(true);
  });

  test("does not verify a PHC-style hash using a non-argon2 algorithm", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const phc = await bcrypt({
      password: PASSWORD,
      salt,
      costFactor: 4,
      outputType: "encoded",
    });
    expect(phc.startsWith("$2a$")).toBe(true);
    // Sanity check: hash-wasm itself can verify its own bcrypt hash.
    expect(await bcryptVerify({ password: PASSWORD, hash: phc })).toBe(true);
    // Our verifyPassword only understands the argon2 family. bcrypt's PHC-ish
    // string doesn't even parse as valid argon2 PHC (its cost-factor segment
    // decodes to a too-short salt), so it rejects outright rather than
    // silently returning `false` or verifying it as if it were argon2id.
    await expect(verifyPassword(PASSWORD, phc)).rejects.toThrow();
  });
});

describe("rate limiting (verifyPassword only)", () => {
  test("returns RATE_LIMITED once the per-user bucket is exhausted", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
      minimumLength: MIN_PASSWORD_LENGTH,
    });

    // Capacity is 5; the first five attempts (wrong password) are allowed, the
    // sixth within the same window is rejected by the limiter.
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: "wrong horse battery staple",
      });
    }
    const result = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: PASSWORD,
    });
    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.userError.error).toBe("RATE_LIMITED");
      if (result.userError.error === "RATE_LIMITED") {
        expect(typeof result.userError.retryAfterMs).toBe("number");
      }
    }
  });
});
