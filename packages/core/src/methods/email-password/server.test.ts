import { describe, expect, test } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { setupEmailPassword, type EmailPasswordOptions } from "./server.ts";

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
