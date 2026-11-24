import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnyDataModel, GenericMutationCtx } from "convex/server";
import { api } from "./_generated/api";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import {
  registerEmail,
  registerResendStub,
} from "@convex-dev/auth/components/email/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const EMAIL = "alice@example.com";
const MINUTE = 60 * 1000;

/** The client IP that the rate limits of `sendEmailShortCode` read. */
const IP = "203.0.113.7";

async function setup() {
  // auth.ts reads the Resend settings from the environment; the stub records
  // them without using them.
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("SENDER_EMAIL", "auth@example.com");

  const t = convexTest(schema, modules);
  registerCore(t);
  registerEmail(t);
  registerResendStub(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type T = Awaited<ReturnType<typeof setup>>;

/**
 * Run a function against a registered component's own database. convex-test
 * exposes `runInComponent` at runtime but does not declare it yet, hence the
 * cast. We use it to read the emails that the Resend stub recorded, and the
 * rows of the email component.
 */
function runInComponent<Output>(
  t: T,
  componentPath: string,
  handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
): Promise<Output> {
  const testApi = t as unknown as {
    runInComponent(
      componentPath: string,
      handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
    ): Promise<Output>;
  };
  return testApi.runInComponent(componentPath, handler);
}

/** The emails the Resend stub recorded, oldest first. */
function sentEmails(t: T) {
  return runInComponent(t, "resend", async (ctx) => {
    const rows = await ctx.db.query("emails").collect();
    return rows.map((row) => ({
      to: row.to as string[],
      subject: row.subject as string,
      text: row.text as string,
      headers: row.headers as { name: string; value: string }[] | undefined,
    }));
  });
}

function verifiedEmails(t: T) {
  return runInComponent(t, "authEmail", async (ctx) => {
    const rows = await ctx.db.query("verifiedEmails").collect();
    return rows.map((row) => ({
      email: row.email as string,
      userId: row.userId as string,
      isPrimary: row.isPrimary as boolean,
    }));
  });
}

function pendingChallenges(t: T) {
  return runInComponent(
    t,
    "authEmail",
    async (ctx) => (await ctx.db.query("challenges").collect()).length,
  );
}

function userIds(t: T) {
  return t.run(async (ctx) =>
    (await ctx.db.query("users").collect()).map((user) => user._id as string),
  );
}

/** The code that an email carries: 8 digits alone on their line. */
function codeInEmail(text: string): string {
  const match = /^(\d{8})$/m.exec(text);
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return match[1];
}

/** An 8-digit code that is not `code`. */
function wrongCode(code: string, i = 0): string {
  return ((Number(code) + 1 + i) % 1e8).toString().padStart(8, "0");
}

/** Submit the email step. */
function send(t: T, email = EMAIL) {
  return t
    .withRequestMetadata({ ip: IP })
    .mutation(api.auth.sendEmailShortCode, { email });
}

/** Submit the email step, and return the secret that the browser keeps. */
async function sendOk(t: T, email = EMAIL) {
  const result = await send(t, email);
  if (!result.success) {
    throw new Error("send failed: " + JSON.stringify(result));
  }
  return result.browserSecret;
}

/** The code of the newest email. */
async function newestCode(t: T) {
  const sent = await sentEmails(t);
  return codeInEmail(sent[sent.length - 1].text);
}

/** Submit the code step in the browser that holds `browserSecret`. */
function enter(t: T, emailCode: string, browserSecret: string) {
  return t.mutation(api.auth.signInWithEmailShortCode, {
    emailCode,
    browserSecret,
  });
}

/** Send a code and enter it. Returns the tokens of the new session. */
async function signIn(t: T, email = EMAIL) {
  const secret = await sendOk(t, email);
  const result = await enter(t, await newestCode(t), secret);
  if (result.status !== "complete") {
    throw new Error("sign-in failed: " + JSON.stringify(result));
  }
  return result.tokens;
}

describe("sendEmailShortCode", () => {
  test("sends the code, and creates no user", async () => {
    const t = await setup();
    expect(await send(t)).toEqual({
      success: true,
      browserSecret: expect.any(String),
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    const code = codeInEmail(sent[0].text);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toBe(`${code} is your code: Sign in`);
    expect(sent[0].text).toContain("Enter this code to sign in:");
    expect(sent[0].text).toContain("stops working after 10 minutes");
    expect(sent[0].text).not.toContain("http");
    expect(sent[0].headers).toEqual([
      {
        name: "OTP-Token",
        value: `"${code}"; origin="http://localhost:5173"`,
      },
    ]);

    expect(await userIds(t)).toEqual([]);
    expect(await verifiedEmails(t)).toEqual([]);
  });

  test("rejects a malformed address, and sends nothing", async () => {
    const t = await setup();
    expect(await send(t, "not-an-email")).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
    expect(await sentEmails(t)).toEqual([]);
  });

  test("refuses the sixth email to one address in an hour", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) {
      await sendOk(t);
    }
    expect(await send(t)).toEqual({
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
  });
});

describe("signInWithEmailShortCode", () => {
  test("a new address: creates the user, records the address, and signs in", async () => {
    const t = await setup();
    const tokens = await signIn(t);
    const { userId } = tokens;
    expect(await userIds(t)).toEqual([userId]);
    expect(await verifiedEmails(t)).toEqual([
      { email: EMAIL, userId, isPrimary: true },
    ]);
    expect(await pendingChallenges(t)).toBe(0);
    expect(
      await t
        .withIdentity(sessionIdentity(tokens))
        .query(api.currentUser.loggedInUser, {}),
    ).toEqual({ id: userId, email: EMAIL });
  });

  test("an address that has an account: signs the same user in", async () => {
    const t = await setup();
    const first = await signIn(t);
    const second = await signIn(t);
    expect(second.userId).toBe(first.userId);
    expect(await userIds(t)).toHaveLength(1);
  });

  test("accepts the code with spaces and dashes", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    const code = await newestCode(t);
    expect(
      await enter(t, ` ${code.slice(0, 4)} - ${code.slice(4)} `, secret),
    ).toMatchObject({ status: "complete" });
  });

  test("fails without the secret of the starting browser, and keeps the code", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    const code = await newestCode(t);
    expect(await enter(t, code, "secret-of-another-browser")).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await enter(t, code, secret)).toMatchObject({ status: "complete" });
  });

  test("a code works once", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    const code = await newestCode(t);
    expect(await enter(t, code, secret)).toMatchObject({ status: "complete" });
    expect(await enter(t, code, secret)).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });

  test("an incorrect code tells how many attempts are left, and the correct code still works", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    const code = await newestCode(t);
    expect(await enter(t, wrongCode(code), secret)).toEqual({
      status: "error",
      userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
    });
    expect(await enter(t, code, secret)).toMatchObject({ status: "complete" });
  });

  test("the fifth incorrect code ends the sign-in", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    const code = await newestCode(t);
    for (let i = 0; i < 5; i++) {
      expect(await enter(t, wrongCode(code, i), secret)).toEqual({
        status: "error",
        userError: { error: "INCORRECT_CODE", attemptsLeft: 4 - i },
      });
    }
    expect(await pendingChallenges(t)).toBe(0);
    expect(await enter(t, code, secret)).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await userIds(t)).toEqual([]);
  });

  test("limits the incorrect codes of an address across new codes", async () => {
    const t = await setup();
    // Two sign-ins use 10 incorrect codes: the limit of the address.
    for (let n = 0; n < 2; n++) {
      const secret = await sendOk(t);
      const code = await newestCode(t);
      for (let i = 0; i < 5; i++) {
        await enter(t, wrongCode(code, i), secret);
      }
    }
    // A third sign-in is limited, even with the correct code.
    const secret = await sendOk(t);
    expect(await enter(t, await newestCode(t), secret)).toEqual({
      status: "error",
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
    expect(await userIds(t)).toEqual([]);
  });

  test("the code of an older email fails, and the newest code still works", async () => {
    const t = await setup();
    await sendOk(t);
    const older = await newestCode(t);
    const secret = await sendOk(t);
    const newest = await newestCode(t);
    expect(await enter(t, older, secret)).toEqual({
      status: "error",
      userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
    });
    expect(await enter(t, newest, secret)).toMatchObject({
      status: "complete",
    });
  });

  test("a code stops working after 10 minutes", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const secret = await sendOk(t);
    const code = await newestCode(t);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(await enter(t, code, secret)).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});
