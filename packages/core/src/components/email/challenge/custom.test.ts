import { afterEach, describe, expect, test, vi } from "vitest";
import {
  registerResendStub,
  stubEmailSender,
  sentEmails,
} from "../../../testing/resend.ts";
import {
  CUSTOM_TTL_DEFAULT_MS,
  CUSTOM_TTL_MAX_MS,
  CUSTOM_TTL_MIN_MS,
} from "../helpers.ts";
import { api } from "../_generated/api.ts";
import { rateLimiter } from "../helpers.ts";
import {
  seedEmail,
  seedChallenge,
  setup as setupComponent,
  verifiedEmailRow,
} from "../../emailTestSetup.ts";

/** The component's test instance, plus the stub that catches the emails. */
function setup() {
  const t = setupComponent();
  registerResendStub(t);
  return t;
}

const IP = "203.0.113.7";
const URL = "https://app.example/reauthenticate";

/** The arguments of a `start` call, except the ones a test sets itself. */
async function startArgs(t: ReturnType<typeof setup>) {
  return {
    email: "alice@example.com",
    url: URL,
    emailSender: await stubEmailSender(t),
    purpose: PURPOSE,
    expectedUserId: "user1",
    subject: "Confirm it is you",
    intro: "Open this link to continue:",
  };
}

/** The code that the emailed link carries. */
function emailCodeInLink(text: string | undefined): string {
  const match = /[?&]code=([^\s&]+)/.exec(text ?? "");
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return decodeURIComponent(match[1]);
}

afterEach(() => {
  vi.useRealTimers();
});

const PURPOSE = "myApp/reauthenticate";

describe("challenge.custom.peek", () => {
  test("without an expectedUserId, gives the owner of the address, and keeps the row", async () => {
    const t = setup();
    await seedEmail(t, "user2", "Alice@Example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    const args = {
      emailCode: "code1",
      browserSecret: "secret1",
      purpose: PURPOSE,
      currentUserId: null,
    };

    expect(await t.query(api.challenge.custom.peek, args)).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: "user2",
    });
    // The peek did not claim the link.
    expect(await t.mutation(api.challenge.custom.complete, args)).toMatchObject(
      { success: true, emailOwnerId: "user2" },
    );
  });

  test("with an expectedUserId, reports INVALID_CHALLENGE when another user owns the address, and keeps the row", async () => {
    const t = setup();
    await seedEmail(t, "user2", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    const args = {
      emailCode: "code1",
      browserSecret: "secret1",
      purpose: PURPOSE,
      currentUserId: "user1",
    };

    expect(await t.query(api.challenge.custom.peek, args)).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(
      await t.run((ctx) => ctx.db.query("challenges").collect()),
    ).toHaveLength(1);
  });
});

describe("challenge.custom.complete", () => {
  test("with an expectedUserId, succeeds when that user owns the address, and writes nothing", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: PURPOSE,
        currentUserId: "user1",
      }),
    ).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: "user1",
    });
    // The emails table did not change.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "Alice@Example.com", isPrimary: true }]);
  });

  test("with an expectedUserId, fails with INVALID_CHALLENGE when another user owns the address", async () => {
    const t = setup();
    // The flow started for user1, but user2 has the address now.
    await seedEmail(t, "user2", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    const args = {
      emailCode: "code1",
      browserSecret: "secret1",
      purpose: PURPOSE,
      currentUserId: "user1",
    };

    expect(await t.mutation(api.challenge.custom.complete, args)).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
    // The claim deleted the row: the link does not work again.
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
  });

  test("with an expectedUserId, fails with INVALID_CHALLENGE when no user owns the address", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: PURPOSE,
        currentUserId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
  });

  test("with a null expectedUserId, gives the owner of the address", async () => {
    const t = setup();
    await seedEmail(t, "user2", "Alice@Example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: PURPOSE,
        currentUserId: null,
      }),
    ).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: "user2",
    });
  });

  test("with a null expectedUserId, does not require the address to be verified", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "nobody@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: PURPOSE,
        currentUserId: null,
      }),
    ).toEqual({
      success: true,
      email: "nobody@example.com",
      emailOwnerId: null,
    });
    expect(await verifiedEmailRow(t, "nobody@example.com")).toBeNull();
  });

  test("another purpose string throws and keeps the row", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    await expect(
      t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: "myApp/otherFlow",
        currentUserId: "user1",
      }),
    ).rejects.toThrow();
    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: PURPOSE,
        currentUserId: "user1",
      }),
    ).toMatchObject({ success: true });
  });

  test("with an expectedUserId, another or a null currentUserId fails with WRONG_USER and keeps the row", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    const args = {
      emailCode: "code1",
      browserSecret: "secret1",
      purpose: PURPOSE,
    };

    expect(
      await t.mutation(api.challenge.custom.complete, {
        ...args,
        currentUserId: "user2",
      }),
    ).toEqual({ success: false, userError: { error: "WRONG_USER" } });
    expect(
      await t.mutation(api.challenge.custom.complete, {
        ...args,
        currentUserId: null,
      }),
    ).toEqual({ success: false, userError: { error: "WRONG_USER" } });
    // The row is kept: the right user can still complete the flow.
    expect(
      await t.mutation(api.challenge.custom.complete, {
        ...args,
        currentUserId: "user1",
      }),
    ).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: "user1",
    });
  });

  test("with a null expectedUserId, accepts a signed-in currentUserId", async () => {
    const t = setup();
    await seedEmail(t, "user2", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: PURPOSE,
        currentUserId: "user1",
      }),
    ).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: "user2",
    });
  });

  test("a built-in challenge cannot be completed as a custom one", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    await expect(
      t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: "addEmail",
        currentUserId: "user1",
      }),
    ).rejects.toThrow();
  });
});

describe("challenge.custom.start", () => {
  test("sends the caller's subject and intro, and returns the secret and the challengeId", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    expect(result).toMatchObject({ success: true });
    if (!result.success) {
      throw new Error("unreachable");
    }
    expect(result.browserSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await t.run((ctx) =>
      ctx.db.get("challenges", result.challengeId),
    );
    expect(row).toMatchObject({
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["alice@example.com"]);
    expect(sent[0].subject).toBe("Confirm it is you");
    expect(sent[0].text).toContain("Open this link to continue:");
    expect(sent[0].text).toContain(`${URL}?code=`);

    // The link and the secret together complete the challenge.
    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: emailCodeInLink(sent[0].text),
        browserSecret: result.browserSecret,
        purpose: PURPOSE,
        currentUserId: "user1",
      }),
    ).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: "user1",
    });
  });

  test("a null expectedUserId stores no user", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, {
        ...(await startArgs(t)),
        expectedUserId: null,
      });
    if (!result.success) {
      throw new Error("unreachable");
    }
    const row = await t.run((ctx) =>
      ctx.db.get("challenges", result.challengeId),
    );
    expect(row?.purpose).toEqual({ kind: "custom", purpose: PURPOSE });
  });

  test("uses the default TTL when ttlMs is absent", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(now);
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    if (!result.success) {
      throw new Error("unreachable");
    }
    const row = await t.run((ctx) =>
      ctx.db.get("challenges", result.challengeId),
    );
    expect(row?.expiresAt).toBe(now + CUSTOM_TTL_DEFAULT_MS);
    expect((await sentEmails(t))[0].text).toContain(
      "stops working after 15 minutes",
    );
  });

  test("throws when ttlMs is outside the bounds", async () => {
    const t = setup();
    const args = await startArgs(t);
    for (const ttlMs of [CUSTOM_TTL_MIN_MS - 1, CUSTOM_TTL_MAX_MS + 1, 0]) {
      await expect(
        t
          .withRequestMetadata({ ip: IP })
          .mutation(api.challenge.custom.start, { ...args, ttlMs }),
      ).rejects.toThrow(/ttlMs must be between/);
    }
    expect(await sentEmails(t)).toEqual([]);
  });

  test("does not check whether the address is verified", async () => {
    const t = setup();
    // The address belongs to another user; a custom flow does not care.
    await seedEmail(t, "user2", "alice@example.com", true);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    expect(result).toMatchObject({ success: true });
    expect(await sentEmails(t)).toHaveLength(1);
  });

  test("consumes the rate limits, and reports RATE_LIMITED without an email", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerEmail", {
        key: "alice@example.com",
        count: 4,
      });
    });
    const args = await startArgs(t);
    const fifth = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, args);
    expect(fifth).toMatchObject({ success: true });
    const sixth = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, args);
    expect(sixth).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
    expect(await sentEmails(t)).toHaveLength(1);
  });
});

describe("challenge.custom.check", () => {
  test("returns null before any start, and consumes nothing", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect(
        await t
          .withRequestMetadata({ ip: IP })
          .mutation(api.challenge.custom.check, { email: "alice@example.com" }),
      ).toBeNull();
    }
    const start = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    expect(start).toMatchObject({ success: true });
  });

  test("returns the same errors as start", async () => {
    const t = setup();
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.custom.check, { email: "not an address" }),
    ).toEqual({ error: "INVALID_EMAIL" });

    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerIp", {
        key: IP,
        count: 20,
      });
    });
    const limited = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.check, { email: "alice@example.com" });
    expect(limited).toMatchObject({ error: "RATE_LIMITED" });
    expect(
      limited?.error === "RATE_LIMITED" && limited.retryAfterMs,
    ).toBeGreaterThan(0);
  });
});

describe("challenge.custom.cancelForUser", () => {
  /** The browser secrets of the pending challenges. */
  async function pendingSecrets(t: ReturnType<typeof setup>) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map(
        (row) => row.browserSecretHash,
      ),
    );
  }

  test("deletes the user's challenges of the purpose, and keeps the others", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);
    await seedEmail(t, "user1", "alice.work@example.com", false);
    await seedEmail(t, "user2", "bob@example.com", true);
    // Sent to an address of the user, with no user bound (recovery links).
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    await seedChallenge(t, {
      email: "alice.work@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code2",
      browserSecret: "secret2",
    });
    // Bound to the user.
    await seedChallenge(t, {
      email: "new@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
      emailCode: "code3",
      browserSecret: "secret3",
    });
    // Another purpose, another kind, and another user: they stay.
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: { kind: "custom", purpose: "myApp/other" },
      emailCode: "code4",
      browserSecret: "secret4",
    });
    await seedChallenge(t, {
      email: "other@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code5",
      browserSecret: "secret5",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      purpose: { kind: "custom", purpose: PURPOSE },
      emailCode: "code6",
      browserSecret: "secret6",
    });
    const before = await pendingSecrets(t);

    await t.mutation(api.challenge.custom.cancelForUser, {
      purpose: PURPOSE,
      userId: "user1",
    });
    expect(await pendingSecrets(t)).toEqual(before.slice(3));

    // Idempotent.
    await t.mutation(api.challenge.custom.cancelForUser, {
      purpose: PURPOSE,
      userId: "user1",
    });
    expect(await pendingSecrets(t)).toEqual(before.slice(3));
  });
});
