import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { encryptTicketPayload } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { registerAttestationSigner } from "../../lib/attestationSigner.fixture.ts";
import {
  NEW_USER_ATTESTATION,
  USER_ATTESTATION,
} from "../../lib/attestationKinds.ts";

/**
 * These tests cover the redemption that every built-in provider shares
 * (`dbHelpers.redeemTicket` and `dbHelpers.linkAccount`), through the Google
 * component, whose account id is the `sub` claim.
 */
const modules = import.meta.glob("./**/*.ts");

const CODE = "ticket-code";
const STATE = "flow-state";

function setup() {
  vi.stubEnv("CLIENT_ID", "test-client-id");
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/oauth/google");
  return convexTest(schema, modules);
}

type TestInstance = ReturnType<typeof setup>;

/** Mint a ticket for the given id_token claims, as the callback does. */
async function mintTicket(t: TestInstance, claims: Record<string, unknown>) {
  const encryptedPayload = await encryptTicketPayload(
    CODE,
    JSON.stringify({ claims }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("tickets", {
      stateHash: await sha256Hex(STATE),
      ticketCodeHash: await sha256Hex(CODE),
      encryptedPayload,
      expiresAt: Date.now() + 60_000,
    });
  });
}

async function accounts(t: TestInstance) {
  return await t.run(async (ctx) => ctx.db.query("accounts").collect());
}

describe("redeemTicket", () => {
  test("attests the user of a known account, and consumes the ticket", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("accounts", {
        providerAccountId: "google-sub-1",
        userId: "user1",
      });
    });
    await mintTicket(t, { sub: "google-sub-1", email: "a@example.com" });

    const result = await t.mutation(api.provider.redeemTicket, {
      ticketCode: CODE,
      state: STATE,
    });
    if (result === null || result.kind !== "existing") {
      throw new Error("expected an existing account");
    }
    expect(result.providerAccountId).toBe("google-sub-1");
    expect(JSON.parse(result.payload)).toEqual({
      claims: { sub: "google-sub-1", email: "a@example.com" },
    });
    expect(decodeJwt(result.attestation)).toMatchObject({
      aud: USER_ATTESTATION.audience,
      userId: "user1",
    });
    expect(
      await t.mutation(api.provider.redeemTicket, {
        ticketCode: CODE,
        state: STATE,
      }),
    ).toBeNull();
  });

  test("returns null for a wrong state", async () => {
    const t = setup();
    await mintTicket(t, { sub: "google-sub-1" });
    expect(
      await t.mutation(api.provider.redeemTicket, {
        ticketCode: CODE,
        state: "another-state",
      }),
    ).toBeNull();
  });

  test("keeps the ticket of a new identity for linkAccount, which attests the new user", async () => {
    const t = setup();
    const core = registerAttestationSigner(t, "auth");
    await mintTicket(t, { sub: "google-sub-2" });

    const result = await t.mutation(api.provider.redeemTicket, {
      ticketCode: CODE,
      state: STATE,
    });
    expect(result).toMatchObject({
      kind: "new",
      providerAccountId: "google-sub-2",
    });
    // The ticket waits for the link: a second redemption finds nothing.
    expect(
      await t.mutation(api.provider.redeemTicket, {
        ticketCode: CODE,
        state: STATE,
      }),
    ).toBeNull();

    const { attestation } = await t.mutation(api.provider.linkAccount, {
      ticketCode: CODE,
      newUser: await core.attest(NEW_USER_ATTESTATION, { userId: "user2" }),
    });
    expect(decodeJwt(attestation)).toMatchObject({
      aud: USER_ATTESTATION.audience,
      userId: "user2",
    });
    expect(await accounts(t)).toMatchObject([
      { providerAccountId: "google-sub-2", userId: "user2" },
    ]);
    expect(
      await t.run(async (ctx) => ctx.db.query("tickets").collect()),
    ).toEqual([]);
  });

  test("linkAccount refuses a new-user attestation that the core did not sign", async () => {
    const t = setup();
    const other = registerAttestationSigner(t, "authOther");
    await mintTicket(t, { sub: "google-sub-2" });
    await t.mutation(api.provider.redeemTicket, {
      ticketCode: CODE,
      state: STATE,
    });
    await expect(
      t.mutation(api.provider.linkAccount, {
        ticketCode: CODE,
        newUser: await other.attest(NEW_USER_ATTESTATION, { userId: "user2" }),
      }),
    ).rejects.toThrow("the core did not sign it");
    expect(await accounts(t)).toEqual([]);
  });

  test("linkAccount refuses a ticket that redeemTicket did not keep", async () => {
    const t = setup();
    const core = registerAttestationSigner(t, "auth");
    await mintTicket(t, { sub: "google-sub-2" });
    await expect(
      t.mutation(api.provider.linkAccount, {
        ticketCode: CODE,
        newUser: await core.attest(NEW_USER_ATTESTATION, { userId: "user2" }),
      }),
    ).rejects.toThrow("No redeemed ticket waits for an account link");
  });

  test("throws for a payload with no `sub` claim", async () => {
    const t = setup();
    await mintTicket(t, { email: "a@example.com" });
    await expect(
      t.mutation(api.provider.redeemTicket, {
        ticketCode: CODE,
        state: STATE,
      }),
    ).rejects.toThrow("has no `sub` claim");
  });
});
