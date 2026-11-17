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

/** The client IP that the rate limits of `sendEmailMagicLink` read. */
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

/** The code that an emailed link carries. */
function emailCodeInLink(text: string): string {
  const match = /[?&]code=([^\s&]+)/.exec(text);
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return decodeURIComponent(match[1]);
}

/** Submit the form. */
function send(t: T, email = EMAIL) {
  return t
    .withRequestMetadata({ ip: IP })
    .mutation(api.auth.sendEmailMagicLink, { email });
}

/** Submit the form, and return the secret that the browser keeps. */
async function sendOk(t: T, email = EMAIL) {
  const result = await send(t, email);
  if (!result.success) {
    throw new Error("send failed: " + JSON.stringify(result));
  }
  return result.browserSecret;
}

/** Open the link of an email in the browser that holds `browserSecret`. */
function open(t: T, email: { text: string }, browserSecret: string) {
  return t.mutation(api.auth.signInWithEmailMagicLink, {
    emailCode: emailCodeInLink(email.text),
    browserSecret,
  });
}

/** Open the link of the newest email. */
async function openNewest(t: T, browserSecret: string) {
  const sent = await sentEmails(t);
  return await open(t, sent[sent.length - 1], browserSecret);
}

/** Send a link and open it. Returns the tokens of the new session. */
async function signIn(t: T, email = EMAIL) {
  const result = await openNewest(t, await sendOk(t, email));
  if (result.status !== "complete") {
    throw new Error("sign-in failed: " + JSON.stringify(result));
  }
  return result.tokens;
}

describe("sendEmailMagicLink", () => {
  test("sends the link, and creates no user", async () => {
    const t = await setup();
    const result = await send(t);
    expect(result).toEqual({
      success: true,
      browserSecret: expect.any(String),
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toBe("Your sign-in link");
    expect(sent[0].text).toContain("Open this link to sign in:");
    expect(sent[0].text).toContain(
      "http://localhost:5173/sign-in-with-link?code=",
    );
    expect(sent[0].text).toContain("stops working after 10 minutes");

    expect(await userIds(t)).toEqual([]);
    expect(await verifiedEmails(t)).toEqual([]);
  });

  test("creates no user, however many times the form is submitted", async () => {
    const t = await setup();
    await sendOk(t);
    await sendOk(t);
    await sendOk(t);
    expect(await userIds(t)).toEqual([]);
  });

  test("rejects a malformed address, and sends nothing", async () => {
    const t = await setup();
    expect(await send(t, "not-an-email")).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
    expect(await sentEmails(t)).toEqual([]);
  });

  test("gives the same result whether or not the address has an account", async () => {
    const t = await setup();
    await signIn(t);
    const known = await send(t, EMAIL);
    const unknown = await send(t, "bob@example.com");
    expect(known).toEqual({ success: true, browserSecret: expect.any(String) });
    expect(unknown).toEqual({
      success: true,
      browserSecret: expect.any(String),
    });
    const [, toKnown, toUnknown] = await sentEmails(t);
    expect(toKnown.subject).toBe(toUnknown.subject);
  });

  test("sends the link to the address as its owner verified it, not as typed", async () => {
    const t = await setup();
    const { userId } = await signIn(t, "Alice@Example.com");
    const secret = await sendOk(t, "alice@example.com");
    const sent = await sentEmails(t);
    expect(sent[1].to).toEqual(["Alice@Example.com"]);

    const result = await openNewest(t, secret);
    expect(result).toMatchObject({ status: "complete", tokens: { userId } });
    expect(await userIds(t)).toHaveLength(1);
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
    expect(await sentEmails(t)).toHaveLength(5);
  });
});

describe("signInWithEmailMagicLink", () => {
  test("a new address: creates the user, records the address, and signs in", async () => {
    const t = await setup();
    const result = await openNewest(t, await sendOk(t));
    expect(result).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    if (result.status !== "complete") {
      throw new Error("unreachable");
    }

    const { userId } = result.tokens;
    expect(await userIds(t)).toEqual([userId]);
    expect(await verifiedEmails(t)).toEqual([
      { email: EMAIL, userId, isPrimary: true },
    ]);
    expect(await pendingChallenges(t)).toBe(0);

    // The session works.
    expect(
      await t
        .withIdentity(sessionIdentity(result.tokens))
        .query(api.currentUser.loggedInUser, {}),
    ).toEqual({ id: userId, email: EMAIL });
  });

  test("an address that has an account: signs the same user in", async () => {
    const t = await setup();
    const first = await signIn(t);
    const second = await signIn(t);
    expect(second.userId).toBe(first.userId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await userIds(t)).toHaveLength(1);
    expect(await verifiedEmails(t)).toHaveLength(1);
  });

  test("signs in a user that another sign-in method created", async () => {
    const t = await setup();
    // The state that another method leaves behind, for example
    // `emailPassword`: an app user with a verified address.
    const userId = await t.run(async (ctx) => await ctx.db.insert("users", {}));
    await runInComponent(t, "authEmail", async (ctx) => {
      await ctx.db.insert("verifiedEmails", {
        email: EMAIL,
        normalizedEmail: EMAIL,
        userId,
        isPrimary: true,
      });
    });

    const tokens = await signIn(t);
    expect(tokens.userId).toBe(userId);
    expect(await userIds(t)).toEqual([userId]);
  });

  test("fails without the secret of the starting browser, and keeps the link", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    expect(await openNewest(t, "secret-of-another-browser")).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await userIds(t)).toEqual([]);
    // The starting browser can still use the link.
    expect(await openNewest(t, secret)).toMatchObject({ status: "complete" });
  });

  test("a link works once", async () => {
    const t = await setup();
    const secret = await sendOk(t);
    expect(await openNewest(t, secret)).toMatchObject({ status: "complete" });
    expect(await openNewest(t, secret)).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await userIds(t)).toHaveLength(1);
  });

  test("an older link fails with INCORRECT_CODE, and the newest link still works", async () => {
    const t = await setup();
    await sendOk(t);
    // The browser keeps one secret: the one of the second email.
    const secret = await sendOk(t);
    const [older, newest] = await sentEmails(t);
    expect(await open(t, older, secret)).toEqual({
      status: "error",
      userError: { error: "INCORRECT_CODE" },
    });
    expect(await open(t, newest, secret)).toMatchObject({
      status: "complete",
    });
  });

  test("a link stops working after 10 minutes", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const secret = await sendOk(t);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(await openNewest(t, secret)).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await userIds(t)).toEqual([]);
  });

  // Two browsers ask for a link for the same new address (for example a
  // laptop and a phone), and the person opens each link in its browser.
  test("two browsers and one new address: both sign in to one user", async () => {
    const t = await setup();
    const laptop = await sendOk(t, "alice@example.com");
    // The person types the address in another case on the phone.
    const phone = await sendOk(t, "Alice@Example.com");
    const [toLaptop, toPhone] = await sentEmails(t);

    const first = await open(t, toLaptop, laptop);
    const second = await open(t, toPhone, phone);
    if (first.status !== "complete" || second.status !== "complete") {
      throw new Error("sign-in failed");
    }
    expect(second.tokens.userId).toBe(first.tokens.userId);
    expect(await userIds(t)).toHaveLength(1);
    // The address stays as the first link recorded it.
    expect(await verifiedEmails(t)).toEqual([
      {
        email: "alice@example.com",
        userId: first.tokens.userId,
        isPrimary: true,
      },
    ]);
  });
});
