import { describe, expect, test } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { setupUsernamePasskey, type UsernamePasskeyOptions } from "./server.ts";

// Setup never calls the components, thus placeholders are enough.
const core = setupConvexAuth({ component: {} as CoreComponentApi });

function setup(origin: UsernamePasskeyOptions["origin"]) {
  return setupUsernamePasskey(core, {
    component: {} as UsernamePasskeyOptions["component"],
    usernameComponent: {} as UsernamePasskeyOptions["usernameComponent"],
    rpId: "example.com",
    origin,
  });
}

describe("setupUsernamePasskey", () => {
  test("accepts one origin or a list of origins", () => {
    expect(() => setup("https://example.com")).not.toThrow();
    expect(() =>
      setup(["https://example.com", "android:apk-key-hash:abc"]),
    ).not.toThrow();
  });

  test("rejects an empty list of origins", () => {
    expect(() => setup([])).toThrow("The origin list cannot be empty");
  });
});
