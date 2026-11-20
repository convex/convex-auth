import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { registerCore, sessionIdentity } from "@convex-dev/auth/test";
import { registerPassword } from "@convex-dev/auth/components/password/test";
import { registerUsername } from "@convex-dev/auth/components/username/test";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple";

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerPassword(t);
  registerUsername(t);
  return t;
}

type ConvexTestApi = ReturnType<typeof setup>;

/** Sign a user up, and return their session. The first one is the admin. */
async function signUp(t: ConvexTestApi, username: string) {
  const result = await t.mutation(api.auth.signUpWithUsernamePassword, {
    username,
    password: PASSWORD,
  });
  if (result.status !== "complete") {
    throw new Error(`Sign-up of ${username} failed`);
  }
  return result.tokens;
}

const as = (t: ConvexTestApi, tokens: { accessToken: string }) =>
  t.withIdentity(sessionIdentity(tokens));

/** The admin, a member, and the admin's impersonation of the member. */
async function startImpersonation(t: ConvexTestApi) {
  const admin = await signUp(t, "admin");
  const alice = await signUp(t, "alice");
  const [target] = await as(t, admin).query(api.users.impersonableUsers, {});
  const result = await as(t, admin).mutation(api.auth.impersonateUser, {
    userId: target.id,
  });
  if (result.status !== "complete") {
    throw new Error("The impersonation did not start");
  }
  return { admin, alice, impersonation: result.tokens };
}

describe("impersonation", () => {
  test("an admin acts as a member, then goes back to their own session", async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);

    expect(
      await as(t, impersonation).query(api.currentUser.loggedInUser, {}),
    ).toMatchObject({ username: "alice", role: "member" });
    expect(
      await as(t, impersonation).query(api.auth.impersonation, {}),
    ).toMatchObject({ expiresAt: expect.any(Number) });

    const stopped = await as(t, impersonation).mutation(
      api.auth.stopImpersonating,
      {},
    );
    if (stopped.status !== "complete") {
      throw new Error("The impersonation did not stop");
    }
    expect(
      await as(t, stopped.tokens).query(api.currentUser.loggedInUser, {}),
    ).toMatchObject({ username: "admin", role: "admin" });
    expect(
      await as(t, stopped.tokens).query(api.auth.impersonation, {}),
    ).toBeNull();
  });

  test("records each impersonation that started", async () => {
    const t = setup();
    const { admin, alice } = await startImpersonation(t);

    const log = await t.run(async (ctx) =>
      ctx.db.query("impersonationLog").collect(),
    );
    expect(log).toMatchObject([
      { impersonatorUserId: admin.userId, targetUserId: alice.userId },
    ]);
  });

  test("a member cannot act as anybody, and sees nobody to act as", async () => {
    const t = setup();
    const admin = await signUp(t, "admin");
    const alice = await signUp(t, "alice");

    expect(await as(t, alice).query(api.users.impersonableUsers, {})).toEqual(
      [],
    );
    expect(
      await as(t, alice).mutation(api.auth.impersonateUser, {
        // The id of the admin's user row.
        userId: (await as(t, admin).query(api.currentUser.loggedInUser, {}))!
          .id,
      }),
    ).toEqual({ status: "error", userError: { error: "NOT_AUTHORIZED" } });
    expect(
      await t.run(async (ctx) => ctx.db.query("impersonationLog").collect()),
    ).toEqual([]);
  });

  test("an admin cannot act as another admin", async () => {
    const t = setup();
    const admin = await signUp(t, "admin");
    const alice = await signUp(t, "alice");
    await t.run(async (ctx) => {
      const users = await ctx.db.query("users").collect();
      for (const user of users) {
        await ctx.db.patch("users", user._id, { role: "admin" });
      }
    });
    const aliceUser = await as(t, alice).query(
      api.currentUser.loggedInUser,
      {},
    );

    expect(
      await as(t, admin).mutation(api.auth.impersonateUser, {
        userId: aliceUser!.id,
      }),
    ).toEqual({ status: "error", userError: { error: "NOT_AUTHORIZED" } });
  });

  test("the password of the impersonated user cannot be changed", async () => {
    const t = setup();
    const { impersonation } = await startImpersonation(t);

    await expect(
      as(t, impersonation).mutation(api.auth.changePassword, {
        // Even an impersonator who knows the password is refused.
        currentPassword: PASSWORD,
        newPassword: "a new password of the impersonator",
      }),
    ).rejects.toThrow("IMPERSONATING");
  });
});
