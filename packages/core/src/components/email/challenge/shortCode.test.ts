import { describe, expect, test } from "vitest";
import {
  registerResendStub,
  stubEmailSender,
  sentEmails,
} from "../../../testing/resend.ts";
import { api } from "../_generated/api.ts";
import { SHORT_CODE_MAX_ATTEMPTS } from "../helpers.ts";
import { generateShortCode } from "../../../lib/crypto.ts";
import { setup as setupComponent } from "../../emailTestSetup.ts";

const IP = "203.0.113.7";
const PURPOSE = "myApp/signIn";
const ORIGIN = "https://app.example.com";

function setup() {
  const t = setupComponent();
  registerResendStub(t);
  return t;
}

/** Start a short-code `custom` challenge, and return its secret and code. */
async function start(t: ReturnType<typeof setup>, email = "alice@example.com") {
  const result = await t
    .withRequestMetadata({ ip: IP })
    .mutation(api.challenge.custom.start, {
      email,
      shortCode: { origin: ORIGIN },
      emailSender: await stubEmailSender(t),
      purpose: PURPOSE,
      expectedUserId: null,
      subject: "Sign in",
      intro: "Enter this code to sign in:",
    });
  if (!result.success) {
    throw new Error("start failed");
  }
  const sent = await sentEmails(t);
  const text = sent.at(-1)!.text!;
  const code = /^(\d{8})$/m.exec(text)![1];
  return { ...result, code, email: sent.at(-1)!, sentCount: sent.length };
}

function completeArgs(browserSecret: string, emailCode: string) {
  return { browserSecret, emailCode, purpose: PURPOSE, currentUserId: null };
}

/** An 8-digit code that is not `code`. */
function wrongCode(code: string, i = 0): string {
  return ((Number(code) + 1 + i) % 1e8).toString().padStart(8, "0");
}

describe("generateShortCode", () => {
  test("gives 8 digits", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateShortCode()).toMatch(/^\d{8}$/);
    }
  });
});

describe("short-code challenges", () => {
  test("emails the code in the subject and on its own line, and stores a keyed hash", async () => {
    const t = setup();
    const { code, email, challengeId } = await start(t);
    expect(email.subject).toBe(`${code} is your code: Sign in`);
    expect(email.text).not.toContain("http");
    expect(email.headers).toEqual([
      { name: "OTP-Token", value: `"${code}"; origin="${ORIGIN}"` },
    ]);
    const row = await t.run((ctx) => ctx.db.get("challenges", challengeId));
    expect(row).toMatchObject({ codeFormat: "shortCode" });
    // The hash is not the plain SHA-256 of the code.
    const plain = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(row!.emailCodeHash).not.toBe(plain);
  });

  test("completes with the correct code, with spaces and dashes accepted", async () => {
    const t = setup();
    const { code, browserSecret } = await start(t);
    const typed = `${code.slice(0, 4)} - ${code.slice(4)}`;
    expect(
      await t.mutation(
        api.challenge.custom.complete,
        completeArgs(browserSecret, typed),
      ),
    ).toEqual({
      success: true,
      email: "alice@example.com",
      emailOwnerId: null,
    });
  });

  test("peek throws: a query cannot count the attempts", async () => {
    const t = setup();
    const { code, browserSecret } = await start(t);
    await expect(
      t.query(api.challenge.custom.peek, completeArgs(browserSecret, code)),
    ).rejects.toThrow(/short code/);
  });

  test("deletes the challenge after the maximum number of incorrect codes", async () => {
    const t = setup();
    const { code, browserSecret } = await start(t);
    for (let i = 0; i < SHORT_CODE_MAX_ATTEMPTS - 1; i++) {
      expect(
        await t.mutation(
          api.challenge.custom.verify,
          completeArgs(browserSecret, wrongCode(code, i)),
        ),
      ).toEqual({
        success: false,
        userError: {
          error: "INCORRECT_CODE",
          attemptsLeft: SHORT_CODE_MAX_ATTEMPTS - 1 - i,
        },
      });
    }
    // The last incorrect code says that no attempt is left.
    expect(
      await t.mutation(
        api.challenge.custom.complete,
        completeArgs(browserSecret, wrongCode(code, 99)),
      ),
    ).toEqual({
      success: false,
      userError: { error: "INCORRECT_CODE", attemptsLeft: 0 },
    });
    // The correct code does not work any more.
    expect(
      await t.mutation(
        api.challenge.custom.complete,
        completeArgs(browserSecret, code),
      ),
    ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
  });

  test("limits the incorrect codes per address across challenges, even for a correct guess", async () => {
    const t = setup();
    // Two challenges for the same address use 8 of the 10 tokens, the third
    // challenge uses the 2 others.
    for (let n = 0; n < 2; n++) {
      const { code, browserSecret } = await start(t);
      for (let i = 0; i < 4; i++) {
        await t.mutation(
          api.challenge.custom.complete,
          completeArgs(browserSecret, wrongCode(code, i)),
        );
      }
    }
    const { code, browserSecret } = await start(t);
    for (let i = 0; i < 2; i++) {
      expect(
        await t.mutation(
          api.challenge.custom.complete,
          completeArgs(browserSecret, wrongCode(code, i)),
        ),
      ).toEqual({
        success: false,
        userError: { error: "INCORRECT_CODE", attemptsLeft: 4 - i },
      });
    }
    const limited = await t.mutation(
      api.challenge.custom.complete,
      completeArgs(browserSecret, code),
    );
    expect(limited).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });

    // Another address is not affected.
    const bob = await start(t, "bob@example.com");
    expect(
      await t.mutation(
        api.challenge.custom.complete,
        completeArgs(bob.browserSecret, bob.code),
      ),
    ).toMatchObject({ success: true });
  });

  test.each([
    ["https://app.example.com/", /canonical form/],
    ["https://App.Example.com", /canonical form/],
    ["https://app.example.com/sign-in", /canonical form/],
    ["http://app.example.com", /not https/],
    ["app.example.com", /not an origin|no origin/],
  ])("rejects the origin %s", async (origin, message) => {
    const t = setup();
    await expect(
      t.withRequestMetadata({ ip: IP }).mutation(api.challenge.custom.start, {
        email: "alice@example.com",
        shortCode: { origin },
        emailSender: await stubEmailSender(t),
        purpose: PURPOSE,
        expectedUserId: null,
        subject: "Sign in",
        intro: "Enter this code to sign in:",
      }),
    ).rejects.toThrow(message);
  });

  test("accepts http on localhost", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, {
        email: "alice@example.com",
        shortCode: { origin: "http://localhost:5173" },
        emailSender: await stubEmailSender(t),
        purpose: PURPOSE,
        expectedUserId: null,
        subject: "Sign in",
        intro: "Enter this code to sign in:",
      });
    expect(result).toMatchObject({ success: true });
  });

  test("a link challenge has no attempt limit", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, {
        email: "alice@example.com",
        url: "https://app.example/landing",
        emailSender: await stubEmailSender(t),
        purpose: PURPOSE,
        expectedUserId: null,
        subject: "Sign in",
        intro: "Open this link:",
      });
    if (!result.success) throw new Error("start failed");
    for (let i = 0; i < SHORT_CODE_MAX_ATTEMPTS + 1; i++) {
      expect(
        await t.mutation(
          api.challenge.custom.complete,
          completeArgs(result.browserSecret, `wrong${i}`),
        ),
      ).toEqual({ success: false, userError: { error: "INCORRECT_CODE" } });
    }
  });
});
