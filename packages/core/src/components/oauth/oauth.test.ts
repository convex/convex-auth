import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.ts";
import {
  decryptTicketPayload,
  encryptTicketPayload,
  generateRandomToken,
} from "../../lib/oauth/crypto.ts";
import schema from "./schema.ts";
import { testAccountsContract } from "../../lib/oauth/componentContract.fixture.ts";

const modules = import.meta.glob("./**/*.ts");

// The component never branches on which provider it serves, so the fixtures
// name none.
const PROVIDER_NAME = "test-provider";
const TOKEN_ENDPOINT = "https://provider.example.com/token";

function setup() {
  vi.stubEnv("CLIENT_ID", "test-client-id");
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv(
    "CONVEX_SITE_URL",
    `https://test.convex.site/oauth/${PROVIDER_NAME}`,
  );
  const t = convexTest(schema, modules);
  return t;
}

/** Args for a valid authorization request, overridable per test. */
const requestArgs = {
  providerName: PROVIDER_NAME,
  stateHash: "0".repeat(64),
  redirectTo: "https://app.example.com/after",
  codeVerifier: "verifier-1",
  tokenEndpoint: TOKEN_ENDPOINT,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("oauth", () => {
  test("createAuthorizationRequest stores the request and returns the provider's client id and callback URL", async () => {
    const t = setup();
    const result = await t.mutation(
      api.provider._internal_dangerous_createAuthorizationRequest,
      requestArgs,
    );
    expect(result).toEqual({
      clientId: "test-client-id",
      callbackUrl: "https://test.convex.site/oauth/test-provider/callback",
    });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(1);
    });
  });

  test("createAuthorizationRequest throws when CONVEX_SITE_URL is not defined", async () => {
    const t = setup();
    vi.stubEnv("CONVEX_SITE_URL", undefined);
    await expect(
      t.mutation(
        api.provider._internal_dangerous_createAuthorizationRequest,
        requestArgs,
      ),
    ).rejects.toThrow(/CONVEX_SITE_URL is not visible/);
  });

  test("claimAuthorizationRequest returns the request exactly once", async () => {
    const t = setup();
    await t.mutation(
      api.provider._internal_dangerous_createAuthorizationRequest,
      requestArgs,
    );
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(claimed).toEqual({
      expired: false,
      providerName: PROVIDER_NAME,
      stateHash: requestArgs.stateHash,
      redirectTo: "https://app.example.com/after",
      callbackUrl: "https://test.convex.site/oauth/test-provider/callback",
      codeVerifier: "verifier-1",
      tokenEndpoint: TOKEN_ENDPOINT,
    });
    const second = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(second).toBeNull();
  });

  test("claimAuthorizationRequest returns null for an unknown state hash", async () => {
    const t = setup();
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: "f".repeat(64) },
    );
    expect(claimed).toBeNull();
  });

  test("claimAuthorizationRequest deletes an expired request and returns only redirectTo", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mutation(
      api.provider._internal_dangerous_createAuthorizationRequest,
      requestArgs,
    );
    vi.advanceTimersByTime(11 * 60 * 1000);
    const claimed = await t.mutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: requestArgs.stateHash },
    );
    expect(claimed).toEqual({
      expired: true,
      redirectTo: "https://app.example.com/after",
    });
    await t.run(async (ctx) => {
      const requests = await ctx.db.query("authorizationRequests").collect();
      expect(requests).toHaveLength(0);
    });
  });

  test("createTicket stores hashed ticket code with expiry", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      providerName: PROVIDER_NAME,
      stateHash: "0".repeat(64),
      ticketCodeHash: "a".repeat(64),
      encryptedPayload: "encrypted-payload",
    });
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
      expect(tickets[0].ticketCodeHash).toBe("a".repeat(64));
      expect(tickets[0].encryptedPayload).toBe("encrypted-payload");
      expect(tickets[0].expiresAt).toBeGreaterThan(Date.now());
    });
  });

  test("claimTicket returns the ticket exactly once", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      providerName: PROVIDER_NAME,
      stateHash: "0".repeat(64),
      ticketCodeHash: "a".repeat(64),
      encryptedPayload: "encrypted-payload",
    });
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: PROVIDER_NAME,
      ticketCodeHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(claimed).toEqual({ encryptedPayload: "encrypted-payload" });
    const second = await t.mutation(api.provider.claimTicket, {
      providerName: PROVIDER_NAME,
      ticketCodeHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(second).toBeNull();
  });

  test("claimTicket returns null on state mismatch and preserves the ticket", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      providerName: PROVIDER_NAME,
      stateHash: "0".repeat(64),
      ticketCodeHash: "a".repeat(64),
      encryptedPayload: "encrypted-payload",
    });
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: PROVIDER_NAME,
      ticketCodeHash: "a".repeat(64),
      stateHash: "f".repeat(64),
    });
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
    });
  });

  test("claimTicket returns null on provider mismatch and preserves the ticket", async () => {
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      providerName: PROVIDER_NAME,
      stateHash: "0".repeat(64),
      ticketCodeHash: "a".repeat(64),
      encryptedPayload: "encrypted-payload",
    });
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: "other-provider",
      ticketCodeHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(1);
    });
  });

  test("claimTicket deletes but does not return an expired ticket", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.mutation(internal.provider.createTicket, {
      providerName: PROVIDER_NAME,
      stateHash: "0".repeat(64),
      ticketCodeHash: "a".repeat(64),
      encryptedPayload: "encrypted-payload",
    });
    vi.advanceTimersByTime(3 * 60 * 1000);
    const claimed = await t.mutation(api.provider.claimTicket, {
      providerName: PROVIDER_NAME,
      ticketCodeHash: "a".repeat(64),
      stateHash: "0".repeat(64),
    });
    expect(claimed).toBeNull();
    await t.run(async (ctx) => {
      const tickets = await ctx.db.query("tickets").collect();
      expect(tickets).toHaveLength(0);
    });
  });

  test("ticket payload encryption round-trips only with the right token", async () => {
    const token = generateRandomToken();
    const payload = JSON.stringify({ claims: { sub: "user-123" } });
    const encrypted = await encryptTicketPayload(token, payload);
    expect(encrypted).not.toContain("user-123");
    expect(await decryptTicketPayload(token, encrypted)).toBe(payload);
    await expect(
      decryptTicketPayload(generateRandomToken(), encrypted),
    ).rejects.toThrow();
  });
});

testAccountsContract(schema, modules);
