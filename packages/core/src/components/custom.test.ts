import { convexTest } from "convex-test";
import { defineSchema } from "convex/server";
import { describe, expect, test } from "vitest";
import { registerAttestationSigner } from "../lib/attestationSigner.fixture.ts";
import {
  NEW_USER_ATTESTATION,
  USER_ATTESTATION,
} from "../lib/attestationKinds.ts";
import { attestUser, verifyNewUser, verifyUser } from "./custom.ts";

function setup() {
  const t = convexTest(defineSchema({}), {
    "./_generated/api.ts": async () => ({}),
  });
  // Register every component before the test runs a function.
  const core = registerAttestationSigner(t, "auth");
  const password = registerAttestationSigner(t, "authPassword");
  const verify = <T>(fn: () => Promise<T>) => t.run(async () => await fn());
  return { core, password, verify };
}

describe("attestUser and verifyUser", () => {
  test("a user attestation of a component verifies, with its path", async () => {
    const { password, verify } = setup();
    const attestation = await attestUser(
      {
        auth: {
          signJwt: async (options) =>
            await password.signJwt(options.claims ?? {}),
        },
      },
      { verifiedUserId: "user1" },
    );
    await expect(verify(() => verifyUser(attestation))).resolves.toEqual({
      userId: "user1",
      componentPath: "authPassword",
    });
  });

  test("attestUser refuses an empty user ID", async () => {
    const { password } = setup();
    await expect(
      attestUser(
        {
          auth: {
            signJwt: async (options) =>
              await password.signJwt(options.claims ?? {}),
          },
        },
        { verifiedUserId: "" },
      ),
    ).rejects.toThrow("empty ID");
  });

  test("verifyUser refuses a new-user attestation", async () => {
    const { core, verify } = setup();
    const newUser = await core.attest(NEW_USER_ATTESTATION, {
      userId: "user1",
    });
    await expect(verify(() => verifyUser(newUser))).rejects.toThrow("audience");
  });
});

describe("verifyNewUser", () => {
  test("accepts a new-user attestation of the core", async () => {
    const { core, verify } = setup();
    const newUser = await core.attest(NEW_USER_ATTESTATION, {
      userId: "user1",
    });
    await expect(verify(() => verifyNewUser(newUser))).resolves.toEqual({
      userId: "user1",
    });
  });

  test("refuses a new-user attestation of another component", async () => {
    const { password, verify } = setup();
    const newUser = await password.attest(NEW_USER_ATTESTATION, {
      userId: "user1",
    });
    await expect(verify(() => verifyNewUser(newUser))).rejects.toThrow(
      'the core did not sign it (it came from "authPassword")',
    );
  });

  test("refuses a user attestation of the core", async () => {
    const { core, verify } = setup();
    const attestation = await core.attest(USER_ATTESTATION, {
      userId: "user1",
    });
    await expect(verify(() => verifyNewUser(attestation))).rejects.toThrow(
      "audience",
    );
  });
});
