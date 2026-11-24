import { describe, expect, expectTypeOf, test } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import {
  setupEmailPassword,
  type CompleteChangeEmailResult,
  type CompleteSignUpResult,
  type EmailPasswordOptions,
} from "./server.ts";

// Setup never calls the components, thus placeholders are enough.
const core = setupConvexAuth({ component: {} as CoreComponentApi });

function setup(urls: EmailPasswordOptions["urls"]) {
  return setupEmailPassword(core, {
    component: {} as EmailPasswordOptions["component"],
    passwordComponent: {} as EmailPasswordOptions["passwordComponent"],
    emailSender: {
      kind: "resend",
      sendEmail: {} as EmailPasswordOptions["emailSender"]["sendEmail"],
      apiKey: "re_test",
      from: "Test <auth@example.com>",
    },
    urls,
  });
}

describe("setupEmailPassword", () => {
  test("accepts absolute URLs", () => {
    expect(() =>
      setup({
        signUp: "http://localhost:5173/validate-email",
        changeEmail: "https://example.com/confirm-email-change",
        recovery: "myapp:///reset-password",
      }),
    ).not.toThrow();
  });

  test("rejects a URL that is missing its scheme", () => {
    expect(() =>
      setup({
        signUp: "https://example.com/validate-email",
        changeEmail: "https://example.com/confirm-email-change",
        recovery: "localhost:5173/reset-password",
      }),
    ).toThrow(/urls\.recovery has no scheme/);
  });

  test("rejects a relative URL", () => {
    expect(() =>
      setup({
        signUp: "/validate-email",
        changeEmail: "https://example.com/confirm-email-change",
        recovery: "https://example.com/reset-password",
      }),
    ).toThrow("urls.signUp is not a full URL");
  });
});

function setupShortCode(
  options: { origin: string } & Partial<EmailPasswordOptions["urls"]>,
) {
  const { origin, ...urls } = options;
  return setupEmailPassword(core, {
    component: {} as EmailPasswordOptions["component"],
    passwordComponent: {} as EmailPasswordOptions["passwordComponent"],
    emailSender: {
      kind: "resend",
      sendEmail: {} as EmailPasswordOptions["emailSender"]["sendEmail"],
      apiKey: "re_test",
      from: "Test <auth@example.com>",
    },
    verification: "shortCode",
    origin,
    urls: urls as { recovery: string },
  });
}

describe('setupEmailPassword with verification: "shortCode"', () => {
  test("accepts an origin and the recovery URL", () => {
    expect(() =>
      setupShortCode({
        origin: "https://app.example.com",
        recovery: "https://app.example.com/reset-password",
      }),
    ).not.toThrow();
  });

  test("rejects an origin that is not canonical", () => {
    expect(() =>
      setupShortCode({
        origin: "https://app.example.com/",
        recovery: "https://app.example.com/reset-password",
      }),
    ).toThrow(/origin is not in canonical form/);
  });

  test("rejects the sign-up and change-email URLs", () => {
    expect(() =>
      setupShortCode({
        origin: "https://app.example.com",
        signUp: "https://app.example.com/validate-email",
        recovery: "https://app.example.com/reset-password",
      }),
    ).toThrow(/send codes, not links/);
  });
});

// Type-only checks: this function is never called.
function _typeChecks() {
  const base = {
    component: {} as EmailPasswordOptions["component"],
    passwordComponent: {} as EmailPasswordOptions["passwordComponent"],
    emailSender: {} as EmailPasswordOptions["emailSender"],
  };
  // @ts-expect-error -- "shortCode" requires `origin`.
  setupEmailPassword(core, {
    ...base,
    verification: "shortCode",
    urls: { recovery: "https://app.example.com/reset-password" },
  });
  setupEmailPassword(core, {
    ...base,
    verification: "shortCode",
    origin: "https://app.example.com",
    urls: {
      recovery: "https://app.example.com/reset-password",
      // @ts-expect-error -- "shortCode" sends no sign-up link.
      signUp: "https://app.example.com/validate-email",
    },
  });
  setupEmailPassword(core, {
    ...base,
    // @ts-expect-error -- links do not take an origin.
    origin: "https://app.example.com",
    urls: {
      signUp: "https://app.example.com/validate-email",
      changeEmail: "https://app.example.com/confirm-email-change",
      recovery: "https://app.example.com/reset-password",
    },
  });
}
void _typeChecks;

describe("result types", () => {
  test("narrow to the verification type", () => {
    type ShortCodeError = Extract<
      CompleteSignUpResult<"shortCode">,
      { status: "error" }
    >["userError"];
    type LinkError = Extract<
      CompleteSignUpResult,
      { status: "error" }
    >["userError"];
    expectTypeOf<
      Extract<ShortCodeError, { error: "INCORRECT_CODE" }>
    >().toEqualTypeOf<{ error: "INCORRECT_CODE"; attemptsLeft: number }>();
    expectTypeOf<
      Extract<LinkError, { error: "INCORRECT_CODE" }>
    >().toEqualTypeOf<{ error: "INCORRECT_CODE" }>();
    expectTypeOf<
      Extract<LinkError, { error: "RATE_LIMITED" }>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<
        Extract<
          CompleteChangeEmailResult<"shortCode">,
          { success: false }
        >["userError"],
        { error: "RATE_LIMITED" }
      >
    >().toEqualTypeOf<{ error: "RATE_LIMITED"; retryAfterMs: number }>();
  });
});
