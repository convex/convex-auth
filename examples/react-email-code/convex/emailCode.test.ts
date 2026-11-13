import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnyDataModel, GenericMutationCtx } from "convex/server";
import { api, components } from "./_generated/api";
import { registerCore } from "@convex-dev/auth/test";
import {
  registerEmail,
  registerResendStub,
} from "@convex-dev/auth/components/email/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const EMAIL = "alice@example.com";

/** The client IP that the rate limits of `start` read. */
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
});

type T = Awaited<ReturnType<typeof setup>>;

/**
 * Run a function against a registered component's own database. convex-test
 * exposes `runInComponent` at runtime but does not declare it yet, hence the
 * cast.
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

/**
 * Put the system in the state that a sign-up with another method leaves
 * behind, here a passkey: an app user, its account in the core, and a
 * verified primary email address.
 */
async function seedUserOfAnotherMethod(t: T, email = EMAIL) {
  const userId = await t.run(async (ctx) => await ctx.db.insert("users", {}));
  await runInComponent(t, "auth", async (ctx) => {
    await ctx.db.insert("accounts", {
      component: "authPasskey",
      providerAccountId: userId,
      userId,
    });
  });
  await runInComponent(t, "authEmail", async (ctx) => {
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: email.toLowerCase().normalize("NFC"),
      userId,
      isPrimary: true,
    });
  });
  return userId;
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

/** The code of a sign-in email: the line that has only digits. */
function codeInEmail(text: string): string {
  const match = /^(\d+)$/m.exec(text);
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return match[1];
}

/** Ask for a code, and return the secret and the code of the email. */
async function startSignIn(t: T, email = EMAIL) {
  const result = await t
    .withRequestMetadata({ ip: IP })
    .mutation(api.auth.startSignInWithEmailCode, { email });
  if (!result.success) {
    throw new Error("The start failed: " + result.userError.error);
  }
  const sent = await sentEmails(t);
  return {
    browserSecret: result.browserSecret,
    code: codeInEmail(sent[sent.length - 1].text),
  };
}

/** A code that is not `code`, with the same length. */
function wrongCode(code: string): string {
  return code.replace(/^./, (digit) => String((Number(digit) + 1) % 10));
}

async function userCount(t: T): Promise<number> {
  return (await t.run((ctx) => ctx.db.query("users").collect())).length;
}

const SESSION_TOKENS = {
  accessToken: expect.any(String),
  refreshToken: expect.any(String),
  refreshTokenExpiresAt: expect.any(Number),
  userId: expect.any(String),
};

describe("startSignInWithEmailCode", () => {
  test("gives the same result whether or not the address has an account", async () => {
    const t = await setup();
    await seedUserOfAnotherMethod(t, "taken@example.com");

    const start = (email: string) =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.startSignInWithEmailCode, { email });
    const taken = await start("taken@example.com");
    const free = await start("free@example.com");

    expect(taken).toEqual({ success: true, browserSecret: expect.any(String) });
    expect(free).toEqual({ success: true, browserSecret: expect.any(String) });
    const sent = await sentEmails(t);
    expect(sent.map((email) => email.subject.replace(/\d+/, "CODE"))).toEqual([
      "CODE is your sign-in code",
      "CODE is your sign-in code",
    ]);
  });

  test("limits the codes for one address", async () => {
    const t = await setup();
    const start = () =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.startSignInWithEmailCode, { email: EMAIL });
    for (let i = 0; i < 5; i++) {
      expect(await start()).toMatchObject({ success: true });
    }
    expect(await start()).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
  });
});

describe("completeSignInWithEmailCode", () => {
  test("creates a user for a new address and signs it in", async () => {
    const t = await setup();
    const { browserSecret, code } = await startSignIn(t);

    const result = await t.mutation(api.auth.completeSignInWithEmailCode, {
      code,
      browserSecret,
    });

    expect(result).toEqual({ status: "complete", tokens: SESSION_TOKENS });
    if (result.status !== "complete") {
      throw new Error("unreachable");
    }
    expect(await userCount(t)).toBe(1);
    expect(
      await t.query(components.authEmail.verifiedEmails.getPrimaryEmail, {
        userId: result.tokens.userId,
      }),
    ).toBe(EMAIL);
  });

  test("signs in the user that verified the address with another method", async () => {
    const t = await setup();
    const userId = await seedUserOfAnotherMethod(t);
    const { browserSecret, code } = await startSignIn(t);

    const result = await t.mutation(api.auth.completeSignInWithEmailCode, {
      code,
      browserSecret,
    });

    expect(result).toEqual({
      status: "complete",
      tokens: { ...SESSION_TOKENS, userId },
    });
    expect(await userCount(t)).toBe(1);
  });

  test("a second code for a new address signs in the user of the first", async () => {
    const t = await setup();
    // Two browsers ask for a code before either signs in.
    const first = await startSignIn(t);
    const second = await startSignIn(t);

    const firstResult = await t.mutation(
      api.auth.completeSignInWithEmailCode,
      first,
    );
    const secondResult = await t.mutation(
      api.auth.completeSignInWithEmailCode,
      second,
    );

    if (firstResult.status !== "complete") {
      throw new Error("The first sign-in failed");
    }
    expect(secondResult).toEqual({
      status: "complete",
      tokens: { ...SESSION_TOKENS, userId: firstResult.tokens.userId },
    });
    expect(await userCount(t)).toBe(1);
  });

  test("a code works once", async () => {
    const t = await setup();
    const { browserSecret, code } = await startSignIn(t);

    await t.mutation(api.auth.completeSignInWithEmailCode, {
      code,
      browserSecret,
    });
    expect(
      await t.mutation(api.auth.completeSignInWithEmailCode, {
        code,
        browserSecret,
      }),
    ).toEqual({ status: "error", userError: { error: "INVALID_CHALLENGE" } });
  });

  test("a code works only with the secret of the browser that asked for it", async () => {
    const t = await setup();
    const { code } = await startSignIn(t);

    expect(
      await t.mutation(api.auth.completeSignInWithEmailCode, {
        code,
        browserSecret: "a secret of another browser",
      }),
    ).toEqual({ status: "error", userError: { error: "INVALID_CHALLENGE" } });
    expect(await userCount(t)).toBe(0);
  });

  test("a wrong code fails, and the right code still works", async () => {
    const t = await setup();
    const { browserSecret, code } = await startSignIn(t);

    expect(
      await t.mutation(api.auth.completeSignInWithEmailCode, {
        code: wrongCode(code),
        browserSecret,
      }),
    ).toEqual({ status: "error", userError: { error: "INCORRECT_CODE" } });
    expect(
      await t.mutation(api.auth.completeSignInWithEmailCode, {
        code,
        browserSecret,
      }),
    ).toMatchObject({ status: "complete" });
  });

  test("the fifth wrong code ends the challenge", async () => {
    const t = await setup();
    await seedUserOfAnotherMethod(t);
    const { browserSecret, code } = await startSignIn(t);
    const complete = (typed: string) =>
      t.mutation(api.auth.completeSignInWithEmailCode, {
        code: typed,
        browserSecret,
      });

    // Each wrong code counts, thus the method returns the failure rather
    // than throwing, which would roll the count back.
    for (let i = 0; i < 4; i++) {
      expect(await complete(wrongCode(code))).toEqual({
        status: "error",
        userError: { error: "INCORRECT_CODE" },
      });
    }
    expect(await complete(wrongCode(code))).toEqual({
      status: "error",
      userError: { error: "TOO_MANY_ATTEMPTS" },
    });
    expect(await complete(code)).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});
