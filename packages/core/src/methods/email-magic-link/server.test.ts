import { describe, expect, test } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { setupEmailMagicLink, type EmailMagicLinkOptions } from "./server.ts";

// Setup never calls the components, thus placeholders are enough.
const core = setupConvexAuth({ component: {} as CoreComponentApi });

function setup(url: string) {
  return setupEmailMagicLink(core, {
    component: {} as EmailMagicLinkOptions["component"],
    emailSender: {
      kind: "resend",
      sendEmail: {} as EmailMagicLinkOptions["emailSender"]["sendEmail"],
      apiKey: "re_test",
      from: "Test <auth@example.com>",
    },
    url,
  });
}

describe("setupEmailMagicLink", () => {
  test("accepts an absolute URL", () => {
    expect(() =>
      setup("http://localhost:5173/sign-in-with-link"),
    ).not.toThrow();
    expect(() => setup("myapp:///sign-in-with-link")).not.toThrow();
  });

  test("rejects a URL that is missing its scheme", () => {
    expect(() => setup("localhost:5173/sign-in-with-link")).toThrow(
      /url has no scheme/,
    );
  });

  test("rejects a relative URL", () => {
    expect(() => setup("/sign-in-with-link")).toThrow("url is not a full URL");
  });
});
