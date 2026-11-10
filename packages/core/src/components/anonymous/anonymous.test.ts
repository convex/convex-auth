import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { registerAttestationSigner } from "../../lib/attestationSigner.fixture.ts";
import {
  NEW_USER_ATTESTATION,
  USER_ATTESTATION,
} from "../../lib/attestationKinds.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  return t;
}

describe("anonymous auth", () => {
  test("createAnonymousAccount records the new user and attests it", async () => {
    const t = setup();
    const newUser = await registerAttestationSigner(t, "auth").attest(
      NEW_USER_ATTESTATION,
      { userId: "user-1" },
    );
    const { attestation } = await t.mutation(
      api.provider.createAnonymousAccount,
      { newUser },
    );
    const accounts = await t.run(
      async (ctx) => await ctx.db.query("accounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ userId: "user-1" });
    expect(decodeJwt(attestation)).toMatchObject({
      aud: USER_ATTESTATION.audience,
      userId: "user-1",
    });
  });

  test("createAnonymousAccount refuses a new-user attestation that the core did not sign", async () => {
    const t = setup();
    const newUser = await registerAttestationSigner(t, "authOther").attest(
      NEW_USER_ATTESTATION,
      { userId: "user-1" },
    );
    await expect(
      t.mutation(api.provider.createAnonymousAccount, { newUser }),
    ).rejects.toThrow("the core did not sign it");
  });
});
