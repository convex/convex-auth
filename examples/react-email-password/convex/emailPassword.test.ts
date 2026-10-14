import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import type { AnyDataModel, GenericMutationCtx } from "convex/server";
import { api, components } from "./_generated/api";
import { registerCore } from "@convex-dev/auth/test";
import { registerPasswordProvider } from "@convex-dev/auth/components/password/test";
import {
  registerEmail,
  registerResendStub,
} from "@convex-dev/auth/components/email/test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid
const EMAIL = "alice@example.com";

async function setup() {
  // The core signs JWTs from these env vars (see the core component, `src/component/public.ts`). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(pkcs8));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );
  // auth.ts reads the Resend settings from the environment; the stub records
  // them without using them.
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("SENDER_EMAIL", "auth@example.com");

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
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
 * cast. We use it to seed component state directly, and to read the emails
 * that the Resend stub recorded.
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
 * Put the system in the state a validated sign-up leaves behind: an app
 * user, its account in the core, a verified primary email, and a password.
 */
async function seedSignedUpUser(
  t: T,
  { email = EMAIL, password = PASSWORD } = {},
) {
  const userId = await t.run(async (ctx) => await ctx.db.insert("users", {}));
  await runInComponent(t, "auth", async (ctx) => {
    await ctx.db.insert("accounts", {
      provider: "emailPassword",
      providerAccountId: userId,
      userId,
    });
  });
  await runInComponent(t, "authEmail", async (ctx) => {
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: normalizeEmail(email),
      userId,
      isPrimary: true,
    });
  });
  await t.run(async (ctx) => {
    const result = await ctx.runMutation(
      components.authPassword.public.setPassword,
      { userId, password },
    );
    if (!result.success) {
      throw new Error("Could not seed the password");
    }
  });
  return userId;
}

/**
 * Configure the passed in `T` with a session for `userId`.
 *
 * The access token's subject is a session id, and the core looks the user up
 * through the session, so this seeds a session for the account
 * `seedSignedUpUser` created.
 */
async function asUser(t: T, userId: string) {
  const sessionId = await runInComponent(t, "auth", async (ctx) => {
    const account = await ctx.db
      .query("accounts")
      .filter((q) => q.eq(q.field("userId"), userId))
      .unique();
    return await ctx.db.insert("sessions", {
      userId,
      accountId: account!._id,
    });
  });
  return t.withIdentity({ subject: sessionId });
}

/**
 * Mirror of the component's `normalizeEmail`, for rows the tests seed
 * directly. The tests do not import component internals.
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().normalize("NFC");
}

/** The purpose of the recipe's recovery challenge, which has no user. */
const RECOVERY = {
  kind: "custom",
  purpose: "convexAuth/emailPassword/recovery",
} as const;

/** The SHA-256 hex digest that the email component stores for a secret. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Seed a pending challenge, hashing the code + secret like production. */
async function seedChallenge(
  t: T,
  args: {
    email: string;
    purpose:
      | { kind: "addEmail"; userId: string }
      | { kind: "changeEmail"; userId: string }
      | { kind: "signUp"; userId: string }
      | { kind: "custom"; userId?: string; purpose: string };
    emailCode: string;
    browserSecret: string;
  },
) {
  await runInComponent(t, "authEmail", async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      purpose: args.purpose,
      emailCodeHash: await sha256Hex(args.emailCode),
      browserSecretHash: await sha256Hex(args.browserSecret),
      expiresAt: Date.now() + 60_000,
    });
  });
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

/** The client IP that the rate limits of the `start` mutations read. */
const IP = "203.0.113.7";

/** The code that an emailed link carries. */
function emailCodeInLink(text: string): string {
  const match = /[?&]code=([^\s&]+)/.exec(text);
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return decodeURIComponent(match[1]);
}

const SESSION_TOKENS = {
  accessToken: expect.any(String),
  refreshToken: expect.any(String),
  refreshTokenExpiresAt: expect.any(Number),
  userId: expect.any(String),
};

describe("signUp", () => {
  test("rejects a malformed email before creating anything", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signUpWithEmailPassword, {
      email: "not-an-email",
      password: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
    const users = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
    expect(users).toBe(0);
  });

  test("rejects a too-short password before creating anything", async () => {
    const t = await setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signUpWithEmailPassword, {
        email: EMAIL,
        password: "short",
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("rejects a frequent password before creating anything", async () => {
    const t = await setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signUpWithEmailPassword, {
        email: EMAIL,
        password: "password123",
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
    const users = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
    expect(users).toBe(0);
  });

  test("rejects an email that is already verified with EMAIL_TAKEN", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signUpWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
  });

  test("EMAIL_TAKEN uses the lookup limit that signIn also uses", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const signUp = () =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.signUpWithEmailPassword, {
          email: EMAIL,
          password: PASSWORD,
        });
    // The lookup limit has 60 tokens per IP.
    for (let i = 0; i < 60; i++) {
      expect(await signUp()).toEqual({
        success: false,
        userError: { error: "EMAIL_TAKEN" },
      });
    }
    expect(await signUp()).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.signInWithEmailPassword, {
          email: EMAIL,
          password: PASSWORD,
        }),
    ).toMatchObject({ status: "error", userError: { error: "RATE_LIMITED" } });
  });

  test("creates the user without a session and sends the link", async () => {
    const t = await setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signUpWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(result).toMatchObject({
      success: true,
      browserSecret: expect.any(String),
    });
    if (!result.success) {
      throw new Error("unreachable");
    }

    // The user exists, but the address is not verified: no sign-in yet.
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.signInWithEmailPassword, {
          email: EMAIL,
          password: PASSWORD,
        }),
    ).toEqual({ status: "error", userError: { error: "USER_NOT_FOUND" } });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/validate/i);
    expect(sent[0].text).toContain(
      "http://localhost:5173/validate-email?code=",
    );

    // The link and the secret complete the sign-up and mint the session.
    expect(
      await t.mutation(api.auth.completeSignUp, {
        emailCode: emailCodeInLink(sent[0].text),
        browserSecret: result.browserSecret,
      }),
    ).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("returns RATE_LIMITED without creating the user", async () => {
    const t = await setup();
    const signUp = () =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.signUpWithEmailPassword, {
          email: EMAIL,
          password: PASSWORD,
        });
    for (let i = 0; i < 5; i++) {
      expect(await signUp()).toMatchObject({ success: true });
    }
    expect(await signUp()).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
    // The limited sign-up left no user behind.
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users).toHaveLength(5);
    expect(await sentEmails(t)).toHaveLength(5);
  });
});

describe("completeSignUp", () => {
  test("validates the email and signs the user in", async () => {
    const t = await setup();
    // The state signUp leaves behind: user + account + password, and a
    // pending challenge (no verified email yet).
    const userId = await t.run(async (ctx) => await ctx.db.insert("users", {}));
    await runInComponent(t, "auth", async (ctx) => {
      await ctx.db.insert("accounts", {
        provider: "emailPassword",
        providerAccountId: userId,
        userId,
      });
    });
    await t.run(async (ctx) => {
      await ctx.runMutation(components.authPassword.public.setPassword, {
        userId,
        password: PASSWORD,
      });
    });
    await seedChallenge(t, {
      email: EMAIL,
      purpose: { kind: "signUp", userId },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    // The link is bound to the user from the sign-up; the browser does not
    // give the user back.
    const result = await t.mutation(api.auth.completeSignUp, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    expect(result).toEqual({ status: "complete", tokens: SESSION_TOKENS });
    expect((result as { tokens: { userId: string } }).tokens.userId).toBe(
      userId,
    );

    // The email is now verified, so sign-in works.
    const signIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(signIn).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("rejects an unknown secret with INVALID_CHALLENGE", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.completeSignUp, {
      emailCode: "unknown",
      browserSecret: "whatever",
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });

  test("the first completed validation wins a duplicate sign-up race", async () => {
    const t = await setup();
    const mkUser = async () => {
      const userId = await t.run(
        async (ctx) => await ctx.db.insert("users", {}),
      );
      await runInComponent(t, "auth", async (ctx) => {
        await ctx.db.insert("accounts", {
          provider: "emailPassword",
          providerAccountId: userId,
          userId,
        });
      });
      return userId;
    };
    const user1 = await mkUser();
    const user2 = await mkUser();
    await seedChallenge(t, {
      email: EMAIL,
      purpose: { kind: "signUp", userId: user1 },
      emailCode: "code1",
      browserSecret: "secret1",
    });
    await seedChallenge(t, {
      email: EMAIL,
      purpose: { kind: "signUp", userId: user2 },
      emailCode: "code2",
      browserSecret: "secret2",
    });

    const first = await t.mutation(api.auth.completeSignUp, {
      emailCode: "code2",
      browserSecret: "secret2",
    });
    expect(first).toEqual({ status: "complete", tokens: SESSION_TOKENS });

    // The other sign-up's link stays pending, but the address is taken now.
    const second = await t.mutation(api.auth.completeSignUp, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    expect(second).toEqual({
      status: "error",
      userError: { error: "EMAIL_TAKEN" },
    });
  });
});

describe("signIn", () => {
  test("signs in with the correct password against a verified email", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(result).toEqual({ status: "complete", tokens: SESSION_TOKENS });
    expect((result as { tokens: { userId: string } }).tokens.userId).toBe(
      userId,
    );
  });

  test("ignores the case of the email", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: "ALICE@Example.COM",
        password: PASSWORD,
      });
    expect(result).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: "wrong horse battery staple",
      });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects an unknown email with USER_NOT_FOUND", async () => {
    const t = await setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: "nobody@example.com",
        password: PASSWORD,
      });
    expect(result).toEqual({
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    });
  });
});

describe("changePassword", () => {
  test("requires a session", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
  });

  test("requires the current password", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await (
      await asUser(t, userId)
    ).mutation(api.auth.changePassword, {
      currentPassword: "wrong horse battery staple",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("reports a malformed current password as INVALID_CREDENTIALS", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await (
      await asUser(t, userId)
    ).mutation(api.auth.changePassword, {
      currentPassword: "short",
      newPassword: "brand new horse staple",
    });
    // A format error about the current password must not look like an error
    // about the new password.
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });

    // The old password still works.
    const signIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(signIn).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("changes the password and notifies the primary email", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await (
      await asUser(t, userId)
    ).mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({ success: true });

    // The old password no longer works; the new one does.
    const oldSignIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(oldSignIn).toMatchObject({ status: "error" });
    const newSignIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: "brand new horse staple",
      });
    expect(newSignIn).toEqual({ status: "complete", tokens: SESSION_TOKENS });

    // A security notification went to the primary address.
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/password/i);
  });
});

describe("startChangeEmail", () => {
  test("requires a session", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.startChangeEmail, {
      newEmail: "new@example.com",
      currentPassword: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
  });

  test("sends a confirmation link to the new address", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const alice = await asUser(t, userId);
    const start = (newEmail: string, currentPassword: string) =>
      alice
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.startChangeEmail, { newEmail, currentPassword });

    // The current password is required, and a wrong one sends nothing.
    expect(await start("new@example.com", "wrong password")).toMatchObject({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await sentEmails(t)).toEqual([]);

    expect(await start("new@example.com", PASSWORD)).toMatchObject({
      success: true,
      browserSecret: expect.any(String),
    });
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["new@example.com"]);
    expect(sent[0].text).toContain(
      "http://localhost:5173/confirm-email-change?code=",
    );
  });
});

describe("completeChangeEmail", () => {
  test("replaces the primary email and notifies the old address", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: "new@example.com",
      purpose: { kind: "changeEmail", userId },
      emailCode: "code1",
      browserSecret: "secret1",
    });

    // Without a session, the link cannot be completed.
    const signedOut = await t.mutation(api.auth.completeChangeEmail, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    expect(signedOut).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });

    const result = await (
      await asUser(t, userId)
    ).mutation(api.auth.completeChangeEmail, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    expect(result).toEqual({ success: true });

    // Sign-in works with the new address, and no longer with the old one.
    const newSignIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: "new@example.com",
        password: PASSWORD,
      });
    expect(newSignIn).toEqual({ status: "complete", tokens: SESSION_TOKENS });
    const oldSignIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: PASSWORD,
      });
    expect(oldSignIn).toEqual({
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    });

    // The notification went to the OLD address: its owner must learn about
    // the change even though the address left the account.
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/email address/i);
  });

  test("rejects an unknown secret with INVALID_CHALLENGE", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await (
      await asUser(t, userId)
    ).mutation(api.auth.completeChangeEmail, {
      emailCode: "unknown",
      browserSecret: "whatever",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});

describe("startPasswordRecovery", () => {
  test("sends a reset link to a verified email", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.startPasswordRecovery, { email: EMAIL });
    expect(result).toMatchObject({
      success: true,
      browserSecret: expect.any(String),
      sentTo: EMAIL,
    });
    if (!result.success) {
      throw new Error("unreachable");
    }
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/reset/i);
    expect(sent[0].text).toContain(
      "http://localhost:5173/reset-password?code=",
    );
    expect(sent[0].text).toContain("stops working after 10 minutes");

    // The link and the secret set the new password and sign the user in.
    expect(
      await t.mutation(api.auth.completePasswordRecovery, {
        emailCode: emailCodeInLink(sent[0].text),
        browserSecret: result.browserSecret,
        newPassword: "brand new horse staple",
      }),
    ).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("sends the link to the stored address when the typed case differs", async () => {
    // A mail server can treat `Alice@` and `alice@` as two mailboxes. The
    // lookup ignores the case, but the link must reach the mailbox that
    // verified the address, or the owner of the other mailbox could reset
    // the password of this account.
    const t = await setup();
    await seedSignedUpUser(t, { email: "Alice@example.com" });
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.startPasswordRecovery, { email: "alice@example.com" });
    // The result names the stored address, so the page shows the mailbox
    // that received the link.
    expect(result).toMatchObject({
      success: true,
      sentTo: "Alice@example.com",
    });
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["Alice@example.com"]);
  });

  test("surfaces EMAIL_NOT_FOUND for an unknown email", async () => {
    const t = await setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.startPasswordRecovery, {
        email: "nobody@example.com",
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_NOT_FOUND" },
    });
    expect(await sentEmails(t)).toEqual([]);
  });
});

describe("checkPasswordRecovery", () => {
  test("accepts a live link without claiming it", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const check = await t.query(api.auth.checkPasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    expect(check).toEqual({ success: true });

    // The link still works after the check.
    const complete = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(complete).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("rejects a wrong code with INCORRECT_CODE", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const check = await t.query(api.auth.checkPasswordRecovery, {
      emailCode: "code2",
      browserSecret: "secret1",
    });
    expect(check).toEqual({
      success: false,
      userError: { error: "INCORRECT_CODE" },
    });
  });

  test("rejects an unknown secret with INVALID_CHALLENGE", async () => {
    const t = await setup();
    const check = await t.query(api.auth.checkPasswordRecovery, {
      emailCode: "unknown",
      browserSecret: "whatever",
    });
    expect(check).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
  });

  test("rejects a link whose address left the account", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });
    // The address is no longer verified for any account.
    await runInComponent(t, "authEmail", async (ctx) => {
      for (const row of await ctx.db.query("verifiedEmails").collect()) {
        await ctx.db.delete("verifiedEmails", row._id);
      }
    });

    const check = await t.query(api.auth.checkPasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
    });
    expect(check).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});

describe("completePasswordRecovery", () => {
  test("sets the new password, signs in, and notifies", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const result = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({ status: "complete", tokens: SESSION_TOKENS });

    const newSignIn = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.auth.signInWithEmailPassword, {
        email: EMAIL,
        password: "brand new horse staple",
      });
    expect(newSignIn).toEqual({ status: "complete", tokens: SESSION_TOKENS });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/password/i);
  });

  test("rejects a malformed new password without burning the link", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const bad = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "short",
    });
    expect(bad).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });

    // The link still works with a valid password.
    const good = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(good).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("rejects a frequent new password without burning the link", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const bad = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "password123",
    });
    expect(bad).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_COMMON" },
    });

    // The link still works with a valid password.
    const good = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(good).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("rejects a link whose address left the account", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });
    // The address is no longer verified for any account.
    await runInComponent(t, "authEmail", async (ctx) => {
      for (const row of await ctx.db.query("verifiedEmails").collect()) {
        await ctx.db.delete("verifiedEmails", row._id);
      }
    });

    const result = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    // Nothing was reset: with the address back, the old password still works.
    await runInComponent(t, "authEmail", async (ctx) => {
      await ctx.db.insert("verifiedEmails", {
        email: EMAIL,
        normalizedEmail: normalizeEmail(EMAIL),
        userId,
        isPrimary: true,
      });
    });
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.signInWithEmailPassword, {
          email: EMAIL,
          password: PASSWORD,
        }),
    ).toEqual({ status: "complete", tokens: SESSION_TOKENS });
  });

  test("a secondary verified address resets the password and notifies the primary", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const SECONDARY = "alice.work@example.com";
    await runInComponent(t, "authEmail", async (ctx) => {
      await ctx.db.insert("verifiedEmails", {
        email: SECONDARY,
        normalizedEmail: normalizeEmail(SECONDARY),
        userId,
        isPrimary: false,
      });
    });
    // The link went to the secondary address: each verified address passed
    // the same ownership challenge, so each of them can reset the password.
    await seedChallenge(t, {
      email: SECONDARY,
      purpose: RECOVERY,
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const result = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "code1",
      browserSecret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({ status: "complete", tokens: SESSION_TOKENS });
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.auth.signInWithEmailPassword, {
          email: EMAIL,
          password: "brand new horse staple",
        }),
    ).toEqual({ status: "complete", tokens: SESSION_TOKENS });

    // The security notification goes to the primary address, not to the
    // address that received the link.
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/password/i);
  });

  test("rejects an unknown secret with INVALID_CHALLENGE", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.completePasswordRecovery, {
      emailCode: "unknown",
      browserSecret: "whatever",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});
