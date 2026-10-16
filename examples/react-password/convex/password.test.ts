import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, components } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/test";
import { registerPasswordProvider } from "@convex-dev/auth/components/password/test";
import { registerUsername } from "@convex-dev/auth/components/username/test";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerUsername(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const signUp = (
  t: Awaited<ReturnType<typeof setup>>,
  username: string,
  password: string,
) => t.mutation(api.auth.signUpWithUsernamePassword, { username, password });

const signIn = (
  t: Awaited<ReturnType<typeof setup>>,
  username: string,
  password: string,
) => t.mutation(api.auth.signInWithUsernamePassword, { username, password });

const asUser = (t: Awaited<ReturnType<typeof setup>>, userId: string) =>
  t.withIdentity({ subject: userId });

type PasswordResult =
  Awaited<ReturnType<typeof signUp>> | Awaited<ReturnType<typeof signIn>>;
type PasswordSuccess = Extract<PasswordResult, { status: "complete" }>;

describe("setupUsernamePassword", () => {
  test("signs up a new user and returns a session", async () => {
    const t = await setup();
    const result = await signUp(t, "alice", PASSWORD);
    expect(result).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
  });

  test("signs in with the correct password", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", PASSWORD);
    const inResult = await signIn(t, "alice", PASSWORD);
    expect(up).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    expect(inResult).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    // Same identity → same app user id.
    expect((inResult as PasswordSuccess).tokens.userId).toBe(
      (up as PasswordSuccess).tokens.userId,
    );
  });

  test("two users get distinct accounts and sessions", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice", PASSWORD);
    const bob = await signUp(t, "bob", "different horse battery staple");
    expect(alice).toMatchObject({ status: "complete" });
    expect(bob).toMatchObject({ status: "complete" });
    expect((bob as PasswordSuccess).tokens.userId).not.toBe(
      (alice as PasswordSuccess).tokens.userId,
    );

    // Each user signs in as themselves, not as the first user.
    const aliceIn = await signIn(t, "alice", PASSWORD);
    const bobIn = await signIn(t, "bob", "different horse battery staple");
    expect((aliceIn as PasswordSuccess).tokens.userId).toBe(
      (alice as PasswordSuccess).tokens.userId,
    );
    expect((bobIn as PasswordSuccess).tokens.userId).toBe(
      (bob as PasswordSuccess).tokens.userId,
    );
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = await setup();
    await signUp(t, "alice", PASSWORD);
    const result = await signIn(t, "alice", "wrong horse battery staple");
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects an unknown username with USER_NOT_FOUND", async () => {
    const t = await setup();
    const result = await signIn(t, "nobody", PASSWORD);
    expect(result).toEqual({
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    });
  });

  test("rejects signing up a taken username", async () => {
    const t = await setup();
    await signUp(t, "alice", PASSWORD);
    const result = await signUp(t, "alice", PASSWORD);
    expect(result).toEqual({
      status: "error",
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("usernames are case-insensitive", async () => {
    const t = await setup();
    const up = await signUp(t, "Alice", PASSWORD);
    expect(up).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });

    // A different casing is treated as the same account for both sign-in...
    const inResult = await signIn(t, "ALICE", PASSWORD);
    expect(inResult).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    expect((inResult as PasswordSuccess).tokens.userId).toBe(
      (up as PasswordSuccess).tokens.userId,
    );

    // ...and the taken-username check.
    const dup = await signUp(t, "alice", PASSWORD);
    expect(dup).toEqual({
      status: "error",
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("rejects an empty username at sign-up", async () => {
    const t = await setup();
    const up = await signUp(t, "", PASSWORD);
    expect(up).toEqual({
      status: "error",
      userError: { error: "USERNAME_TOO_SHORT", minimumLength: 1 },
    });
  });

  test("stores the username in the username component", async () => {
    const t = await setup();
    const up = await signUp(t, "Alice", PASSWORD);
    const rows = await t.run(async (ctx) =>
      ctx.runQuery(components.authUsername.public.getUsername, {
        userId: (up as PasswordSuccess).tokens.userId,
      }),
    );
    expect(rows).toBe("Alice");
  });

  test("rejects a too-short password at sign-up without creating an account", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", "short");
    expect(up).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });

    // No account was created, so a later sign-up with a valid password works.
    const retry = await signUp(t, "alice", PASSWORD);
    expect(retry).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
  });
});

describe("changePassword", () => {
  const NEW_PASSWORD = "new horse battery staple";

  async function signedUpUser() {
    const t = await setup();
    const up = await signUp(t, "alice", PASSWORD);
    const userId = (up as PasswordSuccess).tokens.userId;
    return { t, userId, alice: asUser(t, userId) };
  }

  test("replaces the password when the current one is correct", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({ success: true });

    expect(await signIn(t, "alice", PASSWORD)).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await signIn(t, "alice", NEW_PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("refuses a signed-out caller", async () => {
    const { t } = await signedUpUser();
    const result = await t.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
  });

  test("rejects a wrong current password and keeps the old one", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: "wrong horse battery staple",
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("reports a malformed current password as INVALID_CREDENTIALS", async () => {
    const { alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: "short",
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects a new password that is too common", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "0000000000",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("rejects a new password that is too short", async () => {
    const { alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "short",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("accepts a new password equal to the current one", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(result).toEqual({ success: true });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("rate limits the current-password checks per user", async () => {
    const { alice } = await signedUpUser();
    for (let i = 0; i < 5; i++) {
      await alice.mutation(api.auth.changePassword, {
        currentPassword: "wrong horse battery staple",
        newPassword: NEW_PASSWORD,
      });
    }
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
  });
});
