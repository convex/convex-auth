/**
 * Tests the `emailPassword` method with `verification: "shortCode"`: sign-up
 * and email change send 8-digit codes instead of links.
 *
 * Runs as an app with the core, email, and password components installed
 * (the same harness shape as `server/setup.test.ts`). The examples use
 * links, thus this app covers the short codes.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import type { ComponentApi as EmailComponentApi } from "../../components/email/_generated/component.ts";
import type { ComponentApi as PasswordComponentApi } from "../../components/password/_generated/component.ts";
import type { SendEmailRef } from "../../components/email/helpers.ts";
import type { CreateUserFn, TokenBundle } from "../../lib/types.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { registerCore, sessionIdentity } from "../../testing/core.ts";
import {
  registerEmail,
  registerResendStub,
  sentEmails,
} from "../../testing/email.ts";
import { registerPassword } from "../../testing/password.ts";
import { setupEmailPassword } from "./server.ts";

const ORIGIN = "https://app.example.com";
const IP = "203.0.113.7";
const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";

const components = componentsGeneric() as unknown as {
  auth: CoreComponentApi<"auth">;
  authEmail: EmailComponentApi<"authEmail">;
  authPassword: PasswordComponentApi<"authPassword">;
  resend: { lib: { sendEmail: SendEmailRef } };
};

const schema = defineSchema({ users: defineTable({}) });

const createUser = internalMutationGeneric({
  args: { method: v.any() },
  returns: v.string(),
  handler: async (ctx) => await ctx.db.insert("users", {}),
});

const core = setupConvexAuth({ component: components.auth });

const methods = setupEmailPassword(core, {
  component: components.authEmail,
  passwordComponent: components.authPassword,
  emailSender: {
    kind: "resend",
    sendEmail: components.resend.lib.sendEmail,
    apiKey: "re_test",
    from: "Test <auth@example.com>",
  },
  verification: "shortCode",
  origin: ORIGIN,
  urls: { recovery: `${ORIGIN}/reset-password` },
}).attachUserCallbacks({
  createUser: makeFunctionReference<"mutation">(
    "testApp:createUser",
  ) as unknown as CreateUserFn<"emailPassword", Record<string, never>, "users">,
});

const testApp = { createUser, ...methods };

/**
 * The app's modules. convex-test takes the root directory from the first path
 * that contains `_generated`, so the `_generated/api.ts` entry only has to
 * exist.
 */
const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerEmail(t);
  registerPassword(t);
  registerResendStub(t);
  return t;
}

type T = ReturnType<typeof setup>;

const ref = <Args extends Record<string, unknown>, Result>(name: string) =>
  makeFunctionReference<"mutation", Args, Result>(`testApp:${name}`);

type CompleteResult = {
  status: string;
  tokens?: TokenBundle;
  userError?: unknown;
};

const signUpRef = ref<
  { email: string; password: string },
  { success: true; browserSecret: string } | { success: false }
>("signUpWithEmailPassword");
const completeSignUpRef = ref<
  { emailCode: string; browserSecret: string },
  CompleteResult
>("completeSignUpWithEmailPassword");
const startChangeEmailRef = ref<
  { newEmail: string; currentPassword: string },
  { success: true; browserSecret: string } | { success: false }
>("startChangeEmail");
const completeChangeEmailRef = ref<
  { emailCode: string; browserSecret: string },
  { success: boolean; userError?: unknown }
>("completeChangeEmail");

/** The code of the newest email: 8 digits alone on their line. */
async function newestCode(t: T) {
  const sent = await sentEmails(t);
  const text = sent.at(-1)!.text!;
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

async function signUp(t: T, email = EMAIL) {
  const result = await t
    .withRequestMetadata({ ip: IP })
    .mutation(signUpRef, { email, password: PASSWORD });
  if (!result.success) {
    throw new Error("sign-up failed: " + JSON.stringify(result));
  }
  return result.browserSecret;
}

async function signedUp(t: T) {
  const secret = await signUp(t);
  const result = await t.mutation(completeSignUpRef, {
    emailCode: await newestCode(t),
    browserSecret: secret,
  });
  if (result.status !== "complete") {
    throw new Error("complete failed: " + JSON.stringify(result));
  }
  return result.tokens!;
}

describe('emailPassword with verification: "shortCode"', () => {
  test("sign-up emails a code, with the origin in the OTP-Token header", async () => {
    const t = setup();
    await signUp(t);
    const sent = await sentEmails(t);
    const code = await newestCode(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(
      `${code} is your code: Validate your email address`,
    );
    expect(sent[0].text).toContain(
      "Enter this code to validate your email address:",
    );
    expect(sent[0].text).not.toContain("http");
    expect(sent[0].headers).toEqual([
      { name: "OTP-Token", value: `"${code}"; origin="${ORIGIN}"` },
    ]);
  });

  test("the correct code completes the sign-up and signs in", async () => {
    const t = setup();
    const tokens = await signedUp(t);
    expect(tokens).toMatchObject({ userId: expect.any(String) });
  });

  test("an incorrect code tells how many attempts are left", async () => {
    const t = setup();
    const secret = await signUp(t);
    const code = await newestCode(t);
    expect(
      await t.mutation(completeSignUpRef, {
        emailCode: wrongCode(code),
        browserSecret: secret,
      }),
    ).toEqual({
      status: "error",
      userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
    });
    expect(
      await t.mutation(completeSignUpRef, {
        emailCode: code,
        browserSecret: secret,
      }),
    ).toMatchObject({ status: "complete" });
  });

  test("the fifth incorrect code ends the sign-up", async () => {
    const t = setup();
    const secret = await signUp(t);
    const code = await newestCode(t);
    for (let i = 0; i < 5; i++) {
      await t.mutation(completeSignUpRef, {
        emailCode: wrongCode(code, i),
        browserSecret: secret,
      });
    }
    expect(
      await t.mutation(completeSignUpRef, {
        emailCode: code,
        browserSecret: secret,
      }),
    ).toEqual({ status: "error", userError: { error: "INVALID_CHALLENGE" } });
  });

  test("email change emails a code to the new address, and the code completes it", async () => {
    const t = setup();
    const tokens = await signedUp(t);
    const asAlice = t.withIdentity(sessionIdentity(tokens));
    const start = await asAlice
      .withRequestMetadata({ ip: IP })
      .mutation(startChangeEmailRef, {
        newEmail: "alice@new.example.com",
        currentPassword: PASSWORD,
      });
    if (!start.success) {
      throw new Error("start failed: " + JSON.stringify(start));
    }
    const sent = await sentEmails(t);
    expect(sent.at(-1)!.to).toEqual(["alice@new.example.com"]);
    const code = await newestCode(t);
    expect(sent.at(-1)!.headers).toEqual([
      { name: "OTP-Token", value: `"${code}"; origin="${ORIGIN}"` },
    ]);

    expect(
      await asAlice.mutation(completeChangeEmailRef, {
        emailCode: wrongCode(code),
        browserSecret: start.browserSecret,
      }),
    ).toEqual({
      success: false,
      userError: { error: "INCORRECT_CODE", attemptsLeft: 4 },
    });
    expect(
      await asAlice.mutation(completeChangeEmailRef, {
        emailCode: code,
        browserSecret: start.browserSecret,
      }),
    ).toEqual({ success: true });
  });
});
