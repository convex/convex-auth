// The behavior that every challenge kind shares: the `start` preconditions
// (and the extra ones of the kinds that record an address),
// the one-shot claim, the claim failures, the case of the address, and the
// cleanup when a user is deleted. `custom` is the vehicle unless a test needs
// another kind.

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api.ts";
import { rateLimiter } from "../helpers.ts";
import {
  currentUser,
  seedChallenge,
  seedEmail,
  setup,
} from "../../emailTestSetup.ts";
import { startFreeAddressPreconditions, startPreconditions } from "./common.ts";

const PURPOSE = "myApp/flow";
const CLAIM = { purpose: PURPOSE, currentUserId: null };

async function challengeCount(t: ReturnType<typeof setup>): Promise<number> {
  return (await t.run((ctx) => ctx.db.query("challenges").collect())).length;
}

describe("the one-shot claim", () => {
  test("a second completion fails", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const first = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(first).toMatchObject({ success: true });

    const second = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
  });

  test("a successful claim deletes the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(await challengeCount(t)).toBe(0);
  });

  test("a wrong code with the right secret fails with INCORRECT_CODE and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const wrong = await t.mutation(api.challenge.custom.complete, {
      emailCode: "not-the-code",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(wrong).toEqual({
      success: false,
      userError: { error: "INCORRECT_CODE" },
    });
    expect(await challengeCount(t)).toBe(1);

    // The right code still works.
    const retry = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(retry).toMatchObject({ success: true });
  });

  test("an unknown or empty secret fails with INVALID_CHALLENGE and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    for (const browserSecret of ["not-the-secret", ""]) {
      expect(
        await t.mutation(api.challenge.custom.complete, {
          emailCode: "code1",
          browserSecret,
          ...CLAIM,
        }),
      ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
    }
    // A person with only the link cannot burn the challenge.
    expect(await challengeCount(t)).toBe(1);
  });

  test("an expired link fails with INVALID_CHALLENGE and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await challengeCount(t)).toBe(1);
  });
});

describe("the kind of a challenge", () => {
  test("a challenge of another kind throws and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    // The landing page called the wrong kind: an application bug.
    await expect(
      t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: "addEmail",
        currentUserId: "user1",
      }),
    ).rejects.toThrow(/"addEmail".*"custom"/);
    expect(await challengeCount(t)).toBe(1);
    // The right kind still works.
    const rightKind = await t.mutation(api.challenge.addEmail.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      currentUser: await currentUser(t, "user1"),
    });
    expect(rightKind).toMatchObject({ success: true });
  });
});

describe("the pending challenge address", () => {
  test("keeps the case that the user gave in the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("Alice@Example.com");
  });

  test("complete reports the case that the user gave", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        ...CLAIM,
      }),
    ).toMatchObject({ success: true, email: "Alice@Example.com" });
  });
});

describe("deleteUser with challenges", () => {
  test("removes the user's pending challenges", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      purpose: { kind: "custom", userId: "user2", purpose: PURPOSE },
      emailCode: "code2",
      browserSecret: "secret2",
    });

    await t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" });

    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map(
        (row) => row.purpose.userId,
      ),
    );
    expect(remaining).toEqual(["user2"]);
  });
});

const IP = "203.0.113.7";

function run(
  t: ReturnType<typeof setup>,
  email: string,
  mode: "check" | "consume",
  ip: string | null = IP,
) {
  const runner = ip === null ? t : t.withRequestMetadata({ ip });
  return runner.run((ctx) => startPreconditions(ctx, email, mode));
}

describe("startPreconditions", () => {
  test("rejects an invalid address before it reads the limits", async () => {
    const t = setup();
    // No IP: reading the limits would throw.
    expect(await run(t, "not an address", "consume", null)).toMatchObject({
      error: "INVALID_EMAIL",
    });
  });

  test("check passes any number of times, and consumes nothing", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect(await run(t, "alice@example.com", "check")).toBeNull();
    }
    expect(await run(t, "alice@example.com", "consume")).toBeNull();
  });

  test("consume takes one token per call from the per-address limit", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      expect(await run(t, "alice@example.com", "consume")).toBeNull();
    }
    const limited = await run(t, "alice@example.com", "consume");
    expect(limited).toMatchObject({ error: "RATE_LIMITED" });
    expect(
      limited?.error === "RATE_LIMITED" && limited.retryAfterMs,
    ).toBeGreaterThan(0);
    // Another address from the same IP is fine.
    expect(await run(t, "bob@example.com", "consume")).toBeNull();
  });

  test("the per-address key is the normalized address", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerEmail", {
        key: "alice@example.com",
        count: 5,
      });
    });
    expect(await run(t, "Alice@Example.com", "check")).toMatchObject({
      error: "RATE_LIMITED",
    });
  });

  test("the per-IP limit stops other addresses from the same IP only", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerIp", {
        key: IP,
        count: 20,
      });
    });
    expect(await run(t, "someone.else@example.com", "check")).toMatchObject({
      error: "RATE_LIMITED",
    });
    expect(
      await run(t, "someone.else@example.com", "check", "203.0.113.8"),
    ).toBeNull();
  });

  test("a start that the IP limit denies takes no token from the address", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerIp", {
        key: IP,
        count: 20,
      });
    });
    expect(await run(t, "alice@example.com", "consume")).toMatchObject({
      error: "RATE_LIMITED",
    });
    // The address still has all of its tokens.
    expect(
      await run(t, "alice@example.com", "check", "203.0.113.8"),
    ).toBeNull();
    const perEmail = await t.run((ctx) =>
      rateLimiter.check(ctx, "startChallengePerEmail", {
        key: "alice@example.com",
        count: 5,
      }),
    );
    expect(perEmail.ok).toBe(true);
  });

  test("throws when the request has no client IP", async () => {
    const t = setup();
    await expect(run(t, "alice@example.com", "check", null)).rejects.toThrow(
      /client IP/,
    );
  });
});

function runFree(
  t: ReturnType<typeof setup>,
  email: string,
  mode: "check" | "consume",
) {
  return t
    .withRequestMetadata({ ip: IP })
    .run((ctx) => startFreeAddressPreconditions(ctx, email, mode));
}

/** The whole tokens left in a limit (the bucket refills a little each ms). */
async function tokens(
  t: ReturnType<typeof setup>,
  name: "lookupEmailPerIp" | "startChallengePerIp" | "startChallengePerEmail",
  key: string,
): Promise<number> {
  const { value } = await t.run((ctx) =>
    rateLimiter.getValue(ctx, name, { key }),
  );
  return Math.floor(value);
}

describe("startFreeAddressPreconditions", () => {
  test("check takes a lookup token for EMAIL_TAKEN", async () => {
    const t = setup();
    await seedEmail(t, "user2", "taken@example.com", true);

    expect(await runFree(t, "Taken@Example.com", "check")).toEqual({
      error: "EMAIL_TAKEN",
    });
    expect(await tokens(t, "lookupEmailPerIp", IP)).toBe(59);
  });

  test("check takes no token for a free address", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect(await runFree(t, "alice@example.com", "check")).toBeNull();
    }
    expect(await tokens(t, "lookupEmailPerIp", IP)).toBe(60);
  });

  test("consume takes a lookup token for a free address", async () => {
    const t = setup();
    expect(await runFree(t, "alice@example.com", "consume")).toBeNull();
    expect(await tokens(t, "lookupEmailPerIp", IP)).toBe(59);
    expect(await tokens(t, "startChallengePerIp", IP)).toBe(19);
  });

  test("check then consume in one transaction takes one lookup token", async () => {
    const t = setup();
    await t.withRequestMetadata({ ip: IP }).run(async (ctx) => {
      expect(
        await startFreeAddressPreconditions(ctx, "alice@example.com", "check"),
      ).toBeNull();
      expect(
        await startFreeAddressPreconditions(
          ctx,
          "alice@example.com",
          "consume",
        ),
      ).toBeNull();
    });
    expect(await tokens(t, "lookupEmailPerIp", IP)).toBe(59);
  });

  test("consume takes only a lookup token for EMAIL_TAKEN", async () => {
    const t = setup();
    await seedEmail(t, "user2", "taken@example.com", true);

    expect(await runFree(t, "taken@example.com", "consume")).toEqual({
      error: "EMAIL_TAKEN",
    });
    expect(await tokens(t, "lookupEmailPerIp", IP)).toBe(59);
    // No email goes out, thus the limits of the start keep their tokens.
    expect(await tokens(t, "startChallengePerIp", IP)).toBe(20);
    expect(await tokens(t, "startChallengePerEmail", "taken@example.com")).toBe(
      5,
    );
  });

  test("lookupEmail and EMAIL_TAKEN use the same limit", async () => {
    const t = setup();
    await seedEmail(t, "user2", "taken@example.com", true);
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "lookupEmailPerIp", { key: IP, count: 59 });
    });

    expect(await runFree(t, "taken@example.com", "check")).toEqual({
      error: "EMAIL_TAKEN",
    });
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: "taken@example.com",
        }),
    ).toMatchObject({ success: false, userError: { error: "RATE_LIMITED" } });
  });

  test("with no lookup token, free and taken addresses both get RATE_LIMITED", async () => {
    const t = setup();
    await seedEmail(t, "user2", "taken@example.com", true);
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "lookupEmailPerIp", { key: IP, count: 60 });
    });

    for (const mode of ["check", "consume"] as const) {
      for (const email of ["taken@example.com", "alice@example.com"]) {
        expect(await runFree(t, email, mode)).toMatchObject({
          error: "RATE_LIMITED",
        });
      }
    }
    // The denied start takes no token from the limits of the start.
    expect(await tokens(t, "startChallengePerIp", IP)).toBe(20);
  });

  test("rejects an invalid address before it reads the limits", async () => {
    const t = setup();
    // No IP: reading the limits would throw.
    expect(
      await t.run((ctx) =>
        startFreeAddressPreconditions(ctx, "not an address", "consume"),
      ),
    ).toEqual({ error: "INVALID_EMAIL" });
  });
});
