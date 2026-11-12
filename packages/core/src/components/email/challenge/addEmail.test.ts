import { afterEach, describe, expect, test, vi } from "vitest";
import {
  registerResendStub,
  stubEmailSender,
  sentEmails,
} from "../../../testing/resend.ts";
import { api } from "../_generated/api.ts";
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
const URL = "https://app.example/validate-email";

/** The arguments of a `start` call, except the ones a test sets itself. */
async function startArgs(t: ReturnType<typeof setup>) {
  return {
    email: "alice@example.com",
    url: URL,
    emailSender: await stubEmailSender(t),
    userId: "user1",
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

describe("challenge.addEmail.complete", () => {
  test("records the address; the first email becomes primary", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      userId: "user1",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
    });
    // `addEmail` does not ask for primary, but the first email is always
    // primary.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("a later email stays secondary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@work.example",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      userId: "user1",
    });
    expect(result).toMatchObject({ success: true });
    const emails = await t.query(api.verifiedEmails.getEmails, {
      userId: "user1",
    });
    expect(emails).toContainEqual({
      email: "alice@work.example",
      isPrimary: false,
    });
    expect(emails).toContainEqual({
      email: "alice@example.com",
      isPrimary: true,
    });
  });

  test("an address verified after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    // Another user verifies the address while the link is in flight.
    await seedEmail(t, "user2", "alice@example.com", true);

    const result = await t.mutation(api.challenge.addEmail.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      userId: "user1",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
    // The address still belongs to the user who verified it first.
    expect(await verifiedEmailRow(t, "alice@example.com")).toEqual({
      userId: "user2",
      email: "alice@example.com",
    });
  });

  test("records the case that the user gave", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      userId: "user1",
    });
    expect(result).toMatchObject({
      success: true,
      email: "Alice@Example.com",
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "Alice@Example.com", isPrimary: true }]);
    // The recorded row carries both forms, so a lookup in any case finds it.
    expect(await verifiedEmailRow(t, "ALICE@EXAMPLE.COM")).toEqual({
      userId: "user1",
      email: "Alice@Example.com",
    });
  });

  test("an address verified in another case fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    // Another user verifies the same address, written differently.
    await seedEmail(t, "user2", "alice@EXAMPLE.com", true);

    expect(
      await t.mutation(api.challenge.addEmail.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        userId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });
});

describe("the userId of an addEmail challenge", () => {
  test("another userId fails with WRONG_USER and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "addEmail", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.addEmail.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        userId: "user2",
      }),
    ).toEqual({ success: false, userError: { error: "WRONG_USER" } });
    // Nothing was recorded for either user, and the right user still works.
    expect(await verifiedEmailRow(t, "alice@example.com")).toBeNull();
    expect(
      await t.mutation(api.challenge.addEmail.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        userId: "user1",
      }),
    ).toMatchObject({ success: true, userId: "user1" });
  });
});

describe("challenge.addEmail._internal_dangerous_start", () => {
  test("sends a link and returns the secret", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(
        api.challenge.addEmail._internal_dangerous_start,
        await startArgs(t),
      );
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
      purpose: { kind: "addEmail", userId: "user1" },
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["alice@example.com"]);
    expect(sent[0].subject).toBe("Validate your email address");
    expect(sent[0].text).toContain(
      "Open this link to validate your email address:",
    );
    expect(sent[0].text).toContain(`${URL}?code=`);
    expect(sent[0].text).toContain("stops working after 1 hour");

    // The link and the secret together record the address.
    expect(
      await t.mutation(api.challenge.addEmail.complete, {
        emailCode: emailCodeInLink(sent[0].text),
        browserSecret: result.browserSecret,
        userId: "user1",
      }),
    ).toEqual({ success: true, userId: "user1", email: "alice@example.com" });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("rejects a malformed address with INVALID_EMAIL", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.addEmail._internal_dangerous_start, {
        ...(await startArgs(t)),
        email: "not-an-email",
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
    expect(await sentEmails(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("challenges").collect())).toEqual(
      [],
    );
  });

  test("rejects a taken address with EMAIL_TAKEN, whatever the case", async () => {
    const t = setup();
    await seedEmail(t, "user2", "alice@example.com", true);
    for (const email of ["alice@example.com", "Alice@Example.COM"]) {
      const result = await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.addEmail._internal_dangerous_start, {
          ...(await startArgs(t)),
          email,
        });
      expect(result).toEqual({
        success: false,
        userError: { error: "EMAIL_TAKEN" },
      });
    }
    expect(await sentEmails(t)).toEqual([]);
  });

  test("rate limits per destination email", async () => {
    const t = setup();
    const args = await startArgs(t);
    const start = (email: string) =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.addEmail._internal_dangerous_start, {
          ...args,
          email,
        });
    for (let i = 0; i < 5; i++) {
      expect(await start("alice@example.com")).toMatchObject({ success: true });
    }
    // The key is the normalized address, so another case does not help.
    const limited = await start("Alice@Example.com");
    expect(limited).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
    expect(
      !limited.success &&
        limited.userError.error === "RATE_LIMITED" &&
        limited.userError.retryAfterMs,
    ).toBeGreaterThan(0);
    // Another address from the same IP is still fine.
    expect(await start("bob@example.com")).toMatchObject({ success: true });
    expect(await sentEmails(t)).toHaveLength(6);
  });

  test("rate limits per client IP", async () => {
    const t = setup();
    const args = await startArgs(t);
    const start = (ip: string, email: string) =>
      t
        .withRequestMetadata({ ip })
        .mutation(api.challenge.addEmail._internal_dangerous_start, {
          ...args,
          email,
        });
    for (let i = 0; i < 20; i++) {
      expect(await start(IP, `user${i}@example.com`)).toMatchObject({
        success: true,
      });
    }
    expect(await start(IP, "one.more@example.com")).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
    // Another IP is not affected.
    expect(await start("203.0.113.8", "one.more@example.com")).toMatchObject({
      success: true,
    });
  });

  test("appends the code with ? or & as the URL requires", async () => {
    const t = setup();
    const args = await startArgs(t);
    await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.addEmail._internal_dangerous_start, {
        ...args,
        url: `${URL}?flow=signUp`,
      });
    const [sent] = await sentEmails(t);
    expect(sent.text).toMatch(
      new RegExp(
        `${URL.replace(/[.?]/g, "\\$&")}\\?flow=signUp&code=[A-Za-z0-9_-]{43}`,
      ),
    );
  });

  test("sends through the sender handle with the sender's From address", async () => {
    const t = setup();
    const args = await startArgs(t);
    await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.addEmail._internal_dangerous_start, args);
    const [sent] = await sentEmails(t);
    expect(sent.from).toBe(args.emailSender.from);
  });
});

describe("challenge.addEmail.check", () => {
  test("returns null before any start, and consumes nothing", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect(
        await t
          .withRequestMetadata({ ip: IP })
          .mutation(api.challenge.addEmail.check, {
            email: "alice@example.com",
          }),
      ).toBeNull();
    }
    const start = await t
      .withRequestMetadata({ ip: IP })
      .mutation(
        api.challenge.addEmail._internal_dangerous_start,
        await startArgs(t),
      );
    expect(start).toMatchObject({ success: true });
  });

  test("returns the same errors as start, including EMAIL_TAKEN", async () => {
    const t = setup();
    const check = (email: string) =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.addEmail.check, { email });
    expect(await check("not an address")).toEqual({ error: "INVALID_EMAIL" });

    await seedEmail(t, "user2", "taken@example.com", true);
    expect(await check("Taken@Example.com")).toEqual({ error: "EMAIL_TAKEN" });

    const args = await startArgs(t);
    for (let i = 0; i < 5; i++) {
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.addEmail._internal_dangerous_start, args);
    }
    expect(await check("alice@example.com")).toMatchObject({
      error: "RATE_LIMITED",
    });
  });
});

describe("the cleanup loop", () => {
  test("starting a challenge erases the challenges that expired", async () => {
    vi.useFakeTimers();
    const START = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(START);
    const t = setup();
    await seedChallenge(t, {
      email: "stale@example.com",
      purpose: { kind: "addEmail", userId: "user9" },
      emailCode: "stale",
      browserSecret: "secret",
      expiresAt: START - 1,
    });

    await t
      .withRequestMetadata({ ip: IP })
      .mutation(
        api.challenge.addEmail._internal_dangerous_start,
        await startArgs(t),
      );
    // The loop runs in scheduled functions; let them all complete.
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row.email)).not.toContain(
      "stale@example.com",
    );
    // `runAllTimers` also moves the clock past the TTL of the new challenge,
    // thus the loop erases it too. The cleanup tests show that an unexpired
    // challenge stays.
    expect(remaining).toEqual([]);
  });
});
