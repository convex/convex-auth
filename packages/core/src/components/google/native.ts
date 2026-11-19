/**
 * Sign in with Google from a native app.
 *
 * On iOS the Google Sign-In SDK, and on Android Credential Manager, hand the
 * app an id_token directly, so there is no redirect and no callback. This
 * module verifies that token and mints the same one-time ticket the web
 * callback mints, so the app redeems it with the same `completeSignIn`, and a
 * person reaches the same account from the web and from the app.
 *
 * @module
 */
import { v } from "convex/values";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { internal } from "./_generated/api.ts";
import { action } from "./_generated/server.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { fetchRefusingRedirects } from "../../lib/oauth/callback.ts";
import {
  encryptTicketPayload,
  generateRandomToken,
} from "../../lib/oauth/crypto.ts";
import type { OidcClaims, TicketPayload } from "../../lib/oauth/redemption.ts";
import { vSignInError } from "../../lib/types.ts";
import { ISSUERS, JWKS_ENDPOINT } from "./constants.ts";

/**
 * Google's current signing keys. They are fetched per exchange, so a rotated
 * key is picked up on the next sign-in.
 */
async function fetchGoogleKeys() {
  const response = await fetchRefusingRedirects(JWKS_ENDPOINT, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Fetching Google's signing keys failed with ${response.status}`,
    );
  }
  return createLocalJWKSet(JSON.parse(response.bodyText) as JSONWebKeySet);
}

/** Shortest raw nonce accepted. A random UUID is 36 characters. */
const MIN_NONCE_LENGTH = 16;

const exchangeResult = v.union(
  v.object({
    status: v.literal("exchanged"),
    code: v.string(),
    state: v.string(),
  }),
  // The token is not one Google issued to this app for this sign-in: a bad
  // signature, another audience, expired, or a nonce that doesn't match. The
  // caller can't act on the difference, so they share one code.
  vSignInError(v.object({ error: v.literal("INVALID_ID_TOKEN") })),
);

/**
 * Verify an id_token from Google's native sign-in and mint a one-time ticket
 * for it. Returns the ticket's `code` and `state`, which `completeSignIn`
 * redeems like those of the web callback.
 *
 * The token must:
 *
 * - carry a valid signature from one of Google's published keys;
 * - be issued by Google, unexpired, and addressed to one of `audiences`, the
 *   OAuth client ids the app's native apps request tokens for;
 * - when `nonce` is given, carry a `nonce` claim equal to its hex SHA-256.
 *   The app hashes a fresh random nonce into the sign-in request and sends
 *   the raw one here, so a token taken from elsewhere can't be presented
 *   without it. Without `nonce`, the token is checked as above only.
 *
 * DANGER: the caller supplies `audiences` and decides whether a nonce is
 * required, so the method's setup is what has to fix them.
 */
export const _internal_dangerous_exchangeIdToken = action({
  args: {
    idToken: v.string(),
    nonce: v.optional(v.string()),
    audiences: v.array(v.string()),
  },
  returns: exchangeResult,
  handler: async (ctx, args) => {
    if (args.audiences.length === 0) {
      throw new Error("No native app client ids to accept id_tokens for");
    }
    const nonce = args.nonce;
    // A guessable nonce binds the token to nothing, so a short one is a bug in
    // the app rather than a bad token.
    if (nonce !== undefined && nonce.length < MIN_NONCE_LENGTH) {
      throw new Error(
        `The nonce must be a fresh random value of at least ${MIN_NONCE_LENGTH} characters`,
      );
    }
    // Google being unreachable is not the token's fault, so it throws.
    const googleKeys = await fetchGoogleKeys();
    let claims: OidcClaims;
    try {
      const { payload } = await jwtVerify(args.idToken, googleKeys, {
        issuer: ISSUERS,
        audience: args.audiences,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp"],
      });
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw new Error("id_token subject is invalid");
      }
      if (nonce !== undefined && payload.nonce !== (await sha256Hex(nonce))) {
        throw new Error("id_token nonce does not match");
      }
      claims = payload as OidcClaims;
    } catch (error) {
      console.warn("Google id_token rejected:", error);
      return {
        status: "error" as const,
        userError: { error: "INVALID_ID_TOKEN" as const },
      };
    }

    const state = generateRandomToken();
    const code = generateRandomToken();
    await ctx.runMutation(internal.provider.createTicket, {
      stateHash: await sha256Hex(state),
      ticketCodeHash: await sha256Hex(code),
      encryptedPayload: await encryptTicketPayload(
        code,
        JSON.stringify({ claims } satisfies TicketPayload),
      ),
    });
    return { status: "exchanged" as const, code, state };
  },
});
