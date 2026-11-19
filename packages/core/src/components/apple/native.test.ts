import { convexTest } from "convex-test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";

const modules = import.meta.glob("./**/*.ts");

const BUNDLE_ID = "com.example.app";
const KEY_ID = "apple-key-1";
const JWKS_ENDPOINT = "https://appleid.apple.com/auth/keys";
const NONCE = "6f1c2a0e-5b7d-4e8a-9c3f-2d1b0a9e8f7c";

/** Apple's signing key, and a key Apple never published. */
let appleKey: KeyLike;
let otherKey: KeyLike;

beforeAll(async () => {
  const apple = await generateKeyPair("RS256", { extractable: true });
  appleKey = apple.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(apple.publicKey)), kid: KEY_ID };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== JWKS_ENDPOINT) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

/** An identity token as the system sheet hands it to the app. */
async function identityToken(
  claims: Record<string, unknown> = {},
  key: KeyLike = appleKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: "https://appleid.apple.com",
    aud: BUNDLE_ID,
    sub: "001234.abcdef.0123",
    iat: now,
    exp: now + 600,
    email: "ada@privaterelay.appleid.com",
    email_verified: "true",
    nonce: await sha256Hex(NONCE),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .sign(key);
}

function exchange(
  t: ReturnType<typeof convexTest>,
  args: {
    identityToken: string;
    nonce?: string;
    firstName?: string;
    lastName?: string;
  },
) {
  return t.action(api.native._internal_dangerous_exchangeIdentityToken, {
    nonce: NONCE,
    audiences: [BUNDLE_ID],
    ...args,
  });
}

describe("_internal_dangerous_exchangeIdentityToken", () => {
  test("mints a ticket that carries the claims and the sanitized name", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      identityToken: await identityToken(),
      firstName: "  Ada ",
      lastName: "",
    });
    if (result.status !== "exchanged") {
      throw new Error(`Expected a ticket, got ${JSON.stringify(result)}`);
    }

    const ticket = await t.mutation(api.provider.claimTicket, {
      ticketCodeHash: await sha256Hex(result.code),
      stateHash: await sha256Hex(result.state),
    });
    expect(ticket).not.toBeNull();
    const payload = JSON.parse(
      await decryptTicketPayload(result.code, ticket!.encryptedPayload),
    );
    expect(payload.claims).toMatchObject({
      sub: "001234.abcdef.0123",
      email: "ada@privaterelay.appleid.com",
    });
    expect(payload.callbackParams).toEqual({
      user: { name: { firstName: "Ada" } },
    });
  });

  test("leaves the name out on a return visit", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      identityToken: await identityToken(),
    });
    if (result.status !== "exchanged") {
      throw new Error(`Expected a ticket, got ${JSON.stringify(result)}`);
    }
    const ticket = await t.mutation(api.provider.claimTicket, {
      ticketCodeHash: await sha256Hex(result.code),
      stateHash: await sha256Hex(result.state),
    });
    const payload = JSON.parse(
      await decryptTicketPayload(result.code, ticket!.encryptedPayload),
    );
    expect(payload.callbackParams).toBeUndefined();
  });

  test.each([
    ["a signature by a key Apple never published", {}, "other-key"],
    ["another audience", { aud: "com.example.other" }, "apple"],
    ["another issuer", { iss: "https://accounts.google.com" }, "apple"],
    ["no nonce", { nonce: undefined }, "apple"],
    ["the raw nonce instead of its hash", { nonce: NONCE }, "apple"],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 60 }, "apple"],
  ] as const)("rejects a token with %s", async (_, claims, signer) => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      identityToken: await identityToken(
        claims,
        signer === "apple" ? appleKey : otherKey,
      ),
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_IDENTITY_TOKEN" },
    });
  });

  test("rejects a token presented with another nonce", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      identityToken: await identityToken(),
      nonce: "someone-elses-nonce-0000",
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_IDENTITY_TOKEN" },
    });
  });

  test("throws on a nonce too short to be random", async () => {
    const t = convexTest(schema, modules);
    await expect(
      exchange(t, { identityToken: await identityToken(), nonce: "" }),
    ).rejects.toThrow("at least 16 characters");
  });
});
