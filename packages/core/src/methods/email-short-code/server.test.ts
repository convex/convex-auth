import { describe, expect, test } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { setupEmailShortCode, type EmailShortCodeOptions } from "./server.ts";

// Setup never calls the components, thus placeholders are enough.
const core = setupConvexAuth({ component: {} as CoreComponentApi });

function setup(origin: string) {
  return setupEmailShortCode(core, {
    component: {} as EmailShortCodeOptions["component"],
    emailSender: {
      kind: "resend",
      sendEmail: {} as EmailShortCodeOptions["emailSender"]["sendEmail"],
      apiKey: "re_test",
      from: "Test <auth@example.com>",
    },
    origin,
  });
}

describe("setupEmailShortCode", () => {
  test("accepts a canonical https origin, and http on localhost", () => {
    expect(() => setup("https://app.example.com")).not.toThrow();
    expect(() => setup("http://localhost:5173")).not.toThrow();
  });

  test.each([
    ["https://app.example.com/", /canonical form/],
    ["https://app.example.com/sign-in", /canonical form/],
    ["https://App.Example.com", /canonical form/],
    ["http://app.example.com", /not https/],
    ["app.example.com", /origin/],
  ])("rejects the origin %s", (origin, message) => {
    expect(() => setup(origin)).toThrow(message);
  });
});
