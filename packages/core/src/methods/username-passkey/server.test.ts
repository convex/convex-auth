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

import { makeFunctionReference } from "convex/server";
import {
  credentialSessions,
  assertion,
  attestation,
} from "../credentialSessions.fixture.ts";

for (const [name, args, error] of [
  ["startAddPasskey", {}, null],
  ["verifyAddPasskey", { response: assertion }, "UNKNOWN_CREDENTIAL"],
  ["finishAddPasskey", { response: attestation }, "PROTOCOL_ERROR"],
  [
    "renamePasskey",
    { passkeyId: "missing", name: "New name" },
    "PASSKEY_NOT_FOUND",
  ],
  ["startRemovePasskey", { passkeyId: "missing" }, "PASSKEY_NOT_FOUND"],
  [
    "finishRemovePasskey",
    { passkeyId: "missing", response: assertion },
    "UNKNOWN_CREDENTIAL",
  ],
] as const) {
  test(`${name} rejects impersonation and preserves normal validation`, async () => {
    const { normal, impersonating } = await credentialSessions();
    const fn = makeFunctionReference<"mutation">(`testApp:${name}`);
    await expect(impersonating.mutation(fn, args)).rejects.toThrow(
      /IMPERSONATING/,
    );
    if (error === null) {
      await expect(normal.mutation(fn, args)).rejects.toThrow(
        "The signed-in user has no passkey",
      );
    } else {
      await expect(normal.mutation(fn, args)).resolves.toMatchObject({
        success: false,
        userError: { error },
      });
    }
  });
}
