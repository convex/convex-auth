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
} from "../../emailTestSetup.ts";
import { CODE_ATTEMPTS, SIGN_IN_TTL_DEFAULT_MS } from "../helpers.ts";

/** The component's test instance, plus the stub that catches the emails. */
function setup() {
  const t = setupComponent();
  registerResendStub(t);
  return t;
}

type T = ReturnType<typeof setup>;

const IP = "203.0.113.7";

/** The code of a sign-in email: the line that has only digits. */
function codeInEmail(text: string | undefined): string {
  const match = /^(\d+)$/m.exec(text ?? "");
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return match[1];
}

async function start(
  t: T,
  email: string,
  options: { codeLength?: number; ttlMs?: number } = {},
) {
  return await t
    .withRequestMetadata({ ip: IP })
    .mutation(api.challenge.signIn.start, {
      email,
      emailSender: await stubEmailSender(t),
      ...options,
    });
}

/** Start a challenge, and return its secret and the code of its email. */
async function startAndReadCode(t: T, email: string) {
  const result = await start(t, email);
  if (!result.success) {
    throw new Error("The start failed: " + result.userError.error);
  }
  const sent = await sentEmails(t);
  return {
    browserSecret: result.browserSecret,
    challengeId: result.challengeId,
    code: codeInEmail(sent[sent.length - 1].text),
  };
}

/** A code that is not `code`, with the same length. */
function wrongCode(code: string): string {
  return code.replace(/^./, (digit) => String((Number(digit) + 1) % 10));
}

async function challengeCount(t: T): Promise<number> {
  return (await t.run((ctx) => ctx.db.query("challenges").collect())).length;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("challenge.signIn.start", () => {
  test("sends an 8-digit code, in the subject and on its own line", async () => {
    const t = setup();
    const result = await start(t, "alice@example.com");
    if (!result.success) {
      throw new Error("The start failed: " + result.userError.error);
    }

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["alice@example.com"]);
    const code = codeInEmail(sent[0].text);
    expect(code).toMatch(/^\d{8}$/);
    expect(sent[0].subject).toBe(`${code} is your sign-in code`);
    expect(sent[0].text).toContain("stops working after 10 minutes");

    expect(
      await t.run((ctx) => ctx.db.get("challenges", result.challengeId)),
    ).toMatchObject({
      email: "alice@example.com",
      purpose: { kind: "signIn" },
      attemptsLeft: CODE_ATTEMPTS,
    });
  });

  test("gives the same result whether or not the address has an account", async () => {
    const t = setup();
    await seedEmail(t, "user1", "taken@example.com", true);

    const taken = await start(t, "taken@example.com");
    const free = await start(t, "free@example.com");
    expect(Object.keys(taken).sort()).toEqual(Object.keys(free).sort());
    expect(taken).toMatchObject({ success: true });
    expect(free).toMatchObject({ success: true });
  });

  test("sends the code to the address as its owner verified it", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    await start(t, "alice@example.com");
    const sent = await sentEmails(t);
    expect(sent[0].to).toEqual(["Alice@Example.com"]);
  });

  test("uses the code length and the expiry that the caller gives", async () => {
    const t = setup();
    await start(t, "alice@example.com", {
      codeLength: 6,
      ttlMs: 5 * 60 * 1000,
    });
    const sent = await sentEmails(t);
    expect(codeInEmail(sent[0].text)).toMatch(/^\d{6}$/);
    expect(sent[0].text).toContain("stops working after 5 minutes");
  });

  test.each([5, 11, 6.5])("throws for a code length of %s", async (length) => {
    const t = setup();
    await expect(
      start(t, "alice@example.com", { codeLength: length }),
    ).rejects.toThrow(/codeLength must be an integer between 6 and 10/);
  });

  test.each([30_000, 31 * 60 * 1000])(
    "throws for a ttlMs of %s",
    async (ttlMs) => {
      const t = setup();
      await expect(start(t, "alice@example.com", { ttlMs })).rejects.toThrow(
        /ttlMs must be between/,
      );
    },
  );

  test("rejects a malformed address", async () => {
    const t = setup();
    expect(await start(t, "not an address")).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
    expect(await sentEmails(t)).toEqual([]);
  });

  test("limits the starts for one address", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      expect(await start(t, "alice@example.com")).toMatchObject({
        success: true,
      });
    }
    expect(await start(t, "alice@example.com")).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
    expect(await sentEmails(t)).toHaveLength(5);
  });

  test("limits the starts from one client IP", async () => {
    const t = setup();
    for (let i = 0; i < 20; i++) {
      expect(await start(t, `user${i}@example.com`)).toMatchObject({
        success: true,
      });
    }
    expect(await start(t, "another@example.com")).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
  });
});

describe("challenge.signIn.check", () => {
  test("gives the owner of the address, without claiming", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    const { browserSecret, code } = await startAndReadCode(
      t,
      "alice@example.com",
    );

    expect(
      await t.mutation(api.challenge.signIn.check, { code, browserSecret }),
    ).toEqual({ success: true, email: "alice@example.com", userId: "user1" });
    expect(await challengeCount(t)).toBe(1);
  });

  test("gives null for an address without an owner", async () => {
    const t = setup();
    const { browserSecret, code } = await startAndReadCode(
      t,
      "new@example.com",
    );

    expect(
      await t.mutation(api.challenge.signIn.check, { code, browserSecret }),
    ).toEqual({ success: true, email: "new@example.com", userId: null });
  });

  test("ignores spaces and hyphens in the typed code", async () => {
    const t = setup();
    const { browserSecret, code } = await startAndReadCode(
      t,
      "new@example.com",
    );
    const typed = ` ${code.slice(0, 4)}-${code.slice(4)} `;

    expect(
      await t.mutation(api.challenge.signIn.check, {
        code: typed,
        browserSecret,
      }),
    ).toMatchObject({ success: true });
  });

  test("a wrong code uses one attempt", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { browserSecret, challengeId, code } = await startAndReadCode(
      t,
      "new@example.com",
    );

    expect(
      await t.mutation(api.challenge.signIn.check, {
        code: wrongCode(code),
        browserSecret,
      }),
    ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    expect(
      await t.run((ctx) => ctx.db.get("challenges", challengeId)),
    ).toMatchObject({ attemptsLeft: CODE_ATTEMPTS - 1 });

    // The right code still works.
    expect(
      await t.mutation(api.challenge.signIn.check, { code, browserSecret }),
    ).toMatchObject({ success: true });
  });

  test("the last wrong attempt deletes the challenge", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { browserSecret, code } = await startAndReadCode(
      t,
      "new@example.com",
    );

    for (let i = 1; i < CODE_ATTEMPTS; i++) {
      expect(
        await t.mutation(api.challenge.signIn.check, {
          code: wrongCode(code),
          browserSecret,
        }),
      ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    }
    expect(
      await t.mutation(api.challenge.signIn.check, {
        code: wrongCode(code),
        browserSecret,
      }),
    ).toEqual({ success: false, userError: { error: "TOO_MANY_ATTEMPTS" } });
    expect(await challengeCount(t)).toBe(0);

    // The right code no longer works.
    expect(
      await t.mutation(api.challenge.signIn.check, { code, browserSecret }),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
  });

  test("an expired code fails with INVALID_CHALLENGE", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const { browserSecret, code } = await startAndReadCode(
      t,
      "new@example.com",
    );
    vi.setSystemTime(Date.now() + SIGN_IN_TTL_DEFAULT_MS);

    expect(
      await t.mutation(api.challenge.signIn.check, { code, browserSecret }),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
  });

  test("the code needs the secret of the browser that started", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { code } = await startAndReadCode(t, "new@example.com");
    // Another browser starts its own challenge for the same address.
    const other = await startAndReadCode(t, "new@example.com");

    expect(
      await t.mutation(api.challenge.signIn.check, {
        code,
        browserSecret: "a secret that no challenge has",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
    // The code of the first email is wrong for the second challenge.
    expect(
      await t.mutation(api.challenge.signIn.check, {
        code,
        browserSecret: other.browserSecret,
      }),
    ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
  });

  test("throws for a challenge that sends a link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signUp", userId: "user1" },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    await expect(
      t.mutation(api.challenge.signIn.check, {
        code: "code1",
        browserSecret: "secret1",
      }),
    ).rejects.toThrow(/sends a link, not a short code/);
  });
});

describe("challenge.signIn.complete", () => {
  test("claims the challenge, thus the code works once", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedEmail(t, "user1", "alice@example.com", true);
    const { browserSecret, code } = await startAndReadCode(
      t,
      "alice@example.com",
    );

    expect(
      await t.mutation(api.challenge.signIn.complete, { code, browserSecret }),
    ).toEqual({ success: true, userId: "user1", email: "alice@example.com" });
    expect(
      await t.mutation(api.challenge.signIn.complete, { code, browserSecret }),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
  });

  test("a wrong code uses one attempt", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seedEmail(t, "user1", "alice@example.com", true);
    const { browserSecret, challengeId, code } = await startAndReadCode(
      t,
      "alice@example.com",
    );

    expect(
      await t.mutation(api.challenge.signIn.complete, {
        code: wrongCode(code),
        browserSecret,
      }),
    ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    expect(
      await t.run((ctx) => ctx.db.get("challenges", challengeId)),
    ).toMatchObject({ attemptsLeft: CODE_ATTEMPTS - 1 });
  });

  test("throws for an address without an owner", async () => {
    const t = setup();
    const { browserSecret, code } = await startAndReadCode(
      t,
      "new@example.com",
    );

    await expect(
      t.mutation(api.challenge.signIn.complete, { code, browserSecret }),
    ).rejects.toThrow(/no user owns the address/);
    expect(await challengeCount(t)).toBe(1);
  });
});

describe("challenge.signIn._internal_dangerous_completeForNewUser", () => {
  test("records the address as the primary address of the user", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { browserSecret, code } = await startAndReadCode(
      t,
      "New@Example.com",
    );

    expect(
      await t.mutation(
        api.challenge.signIn._internal_dangerous_completeForNewUser,
        { code, browserSecret, newUserId: "user1" },
      ),
    ).toEqual({ success: true, userId: "user1", email: "New@Example.com" });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "New@Example.com", isPrimary: true }]);
    expect(
      await t.mutation(
        api.challenge.signIn._internal_dangerous_completeForNewUser,
        { code, browserSecret, newUserId: "user1" },
      ),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
  });

  test("throws when a user owns the address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    const { browserSecret, code } = await startAndReadCode(
      t,
      "alice@example.com",
    );

    await expect(
      t.mutation(api.challenge.signIn._internal_dangerous_completeForNewUser, {
        code,
        browserSecret,
        newUserId: "user2",
      }),
    ).rejects.toThrow(/a user already owns the address/);
  });

  test("throws when the user already has an address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    const { browserSecret, code } = await startAndReadCode(
      t,
      "new@example.com",
    );

    await expect(
      t.mutation(api.challenge.signIn._internal_dangerous_completeForNewUser, {
        code,
        browserSecret,
        newUserId: "user1",
      }),
    ).rejects.toThrow(/already has an email address/);
  });
});

describe("the functions for links", () => {
  test("throw for a challenge that sends a code, before they compare it", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signIn" },
      emailCode: "12345678",
      browserSecret: "secret1",
      attemptsLeft: CODE_ATTEMPTS,
    });

    // The right code and a wrong code give the same error, thus a peek
    // cannot be used to try codes.
    for (const emailCode of ["12345678", "87654321"]) {
      await expect(
        t.query(api.challenge.custom.peek, {
          emailCode,
          browserSecret: "secret1",
          purpose: "myApp/recovery",
          currentUserId: null,
        }),
      ).rejects.toThrow(/sends a short code, not a link/);
    }
    // The row and its attempts stay.
    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toMatchObject([{ attemptsLeft: CODE_ATTEMPTS }]);
  });

  test("complete throws for a challenge that sends a code, and leaves it", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: { kind: "signIn" },
      emailCode: "12345678",
      browserSecret: "secret1",
      attemptsLeft: CODE_ATTEMPTS,
    });

    await expect(
      t.mutation(api.challenge.custom.complete, {
        emailCode: "12345678",
        browserSecret: "secret1",
        purpose: "myApp/recovery",
        currentUserId: null,
      }),
    ).rejects.toThrow(/sends a short code, not a link/);
    await expect(
      t.mutation(api.challenge.signUp.complete, {
        emailCode: "87654321",
        browserSecret: "secret1",
      }),
    ).rejects.toThrow(/sends a short code, not a link/);
    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toMatchObject([{ attemptsLeft: CODE_ATTEMPTS }]);
  });
});
