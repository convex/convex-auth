import { convexTest } from "convex-test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { decryptTicketPayload } from "../../lib/oauth/crypto.ts";

const modules = import.meta.glob("./**/*.ts");

const CLIENT_ID = "1234-ios.apps.googleusercontent.com";
const KEY_ID = "google-key-1";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const NONCE = "6f1c2a0e-5b7d-4e8a-9c3f-2d1b0a9e8f7c";

/** Google's signing key, and a key Google never published. */
let googleKey: KeyLike;
let otherKey: KeyLike;

beforeAll(async () => {
  const google = await generateKeyPair("RS256", { extractable: true });
  googleKey = google.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(google.publicKey)), kid: KEY_ID };
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

/** An id_token as Google's native SDK hands it to the app. */
async function idToken(
  claims: Record<string, unknown> = {},
  key: KeyLike = googleKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "110169484474386276334",
    iat: now,
    exp: now + 3600,
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    nonce: await sha256Hex(NONCE),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .sign(key);
}

function exchange(
  t: ReturnType<typeof convexTest>,
  args: { idToken: string; nonce?: string },
) {
  return t.action(api.native._internal_dangerous_exchangeIdToken, {
    audiences: [CLIENT_ID],
    ...args,
  });
}

async function claimedPayload(
  t: ReturnType<typeof convexTest>,
  result: Awaited<ReturnType<typeof exchange>>,
) {
  if (result.status !== "exchanged") {
    throw new Error(`Expected a ticket, got ${JSON.stringify(result)}`);
  }
  const ticket = await t.mutation(api.provider.claimTicket, {
    ticketCodeHash: await sha256Hex(result.code),
    stateHash: await sha256Hex(result.state),
  });
  expect(ticket).not.toBeNull();
  return JSON.parse(
    await decryptTicketPayload(result.code, ticket!.encryptedPayload),
  );
}

describe("_internal_dangerous_exchangeIdToken", () => {
  test("mints a ticket that carries the claims", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      idToken: await idToken(),
      nonce: NONCE,
    });
    const payload = await claimedPayload(t, result);
    expect(payload.claims).toMatchObject({
      sub: "110169484474386276334",
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
  });

  test("accepts the issuer without the https prefix", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      idToken: await idToken({ iss: "accounts.google.com" }),
      nonce: NONCE,
    });
    expect(result.status).toBe("exchanged");
  });

  test("checks no nonce when the caller sends none", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      idToken: await idToken({ nonce: undefined }),
    });
    expect(result.status).toBe("exchanged");
  });

  test.each([
    ["a signature by a key Google never published", {}, "other-key"],
    [
      "another audience",
      { aud: "5678-other.apps.googleusercontent.com" },
      "google",
    ],
    ["another issuer", { iss: "https://appleid.apple.com" }, "google"],
    ["no nonce", { nonce: undefined }, "google"],
    ["the raw nonce instead of its hash", { nonce: NONCE }, "google"],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 60 }, "google"],
  ] as const)("rejects a token with %s", async (_, claims, signer) => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      idToken: await idToken(
        claims,
        signer === "google" ? googleKey : otherKey,
      ),
      nonce: NONCE,
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_ID_TOKEN" },
    });
  });

  test("rejects a token presented with another nonce", async () => {
    const t = convexTest(schema, modules);
    const result = await exchange(t, {
      idToken: await idToken(),
      nonce: "someone-elses-nonce-0000",
    });
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_ID_TOKEN" },
    });
  });

  test("throws on a nonce too short to be random", async () => {
    const t = convexTest(schema, modules);
    await expect(
      exchange(t, { idToken: await idToken(), nonce: "" }),
    ).rejects.toThrow("at least 16 characters");
  });
});
