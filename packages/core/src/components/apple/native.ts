/**
 * Sign in with Apple from a native app.
 *
 * On iOS the system sheet (`ASAuthorizationAppleIDProvider`) hands the app an
 * identity token directly, so there is no redirect and no callback. This
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
import { ISSUER, JWKS_ENDPOINT } from "./constants.ts";
import { sanitizeAppleName } from "./user.ts";

/**
 * Apple's current signing keys. They are fetched per exchange, so a rotated
 * key is picked up on the next sign-in.
 */
async function fetchAppleKeys() {
  const response = await fetchRefusingRedirects(JWKS_ENDPOINT, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Fetching Apple's signing keys failed with ${response.status}`,
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
  // The token is not one Apple issued to this app for this sign-in: a bad
  // signature, another audience, expired, or a nonce that doesn't match. The
  // caller can't act on the difference, so they share one code.
  vSignInError(v.object({ error: v.literal("INVALID_IDENTITY_TOKEN") })),
);

/**
 * Verify an identity token from Apple's native sign-in and mint a one-time
 * ticket for it. Returns the ticket's `code` and `state`, which
 * `completeSignIn` redeems like those of the web callback.
 *
 * The token must:
 *
 * - carry a valid signature from one of Apple's published keys;
 * - be issued by Apple, unexpired, and addressed to one of `audiences`, the
 *   bundle ids of the app's native apps;
 * - carry a `nonce` claim equal to the hex SHA-256 of `nonce`. The app hashes
 *   a fresh random nonce into the sign-in request and sends the raw one here,
 *   so a token taken from elsewhere can't be presented without it.
 *
 * DANGER: the caller supplies `audiences`, and a token for any of them signs
 * a person in, so the method's setup is what has to fix them.
 */
export const _internal_dangerous_exchangeIdentityToken = action({
  args: {
    identityToken: v.string(),
    nonce: v.string(),
    audiences: v.array(v.string()),
    // Apple gives the name to the app, on the first authorization only.
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
  },
  returns: exchangeResult,
  handler: async (ctx, args) => {
    if (args.audiences.length === 0) {
      throw new Error("No native app bundle ids to accept identity tokens for");
    }
    // A guessable nonce binds the token to nothing, so a short one is a bug in
    // the app rather than a bad token.
    if (args.nonce.length < MIN_NONCE_LENGTH) {
      throw new Error(
        `The nonce must be a fresh random value of at least ${MIN_NONCE_LENGTH} characters`,
      );
    }
    // Apple being unreachable is not the token's fault, so it throws.
    const appleKeys = await fetchAppleKeys();
    let claims: OidcClaims;
    try {
      const { payload } = await jwtVerify(args.identityToken, appleKeys, {
        issuer: ISSUER,
        audience: args.audiences,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "nonce"],
      });
      if (
        typeof payload.sub !== "string" ||
        payload.sub === "" ||
        payload.nonce !== (await sha256Hex(args.nonce))
      ) {
        throw new Error("Identity token subject or nonce is invalid");
      }
      claims = payload as OidcClaims;
    } catch (error) {
      console.warn("Apple identity token rejected:", error);
      return {
        status: "error" as const,
        userError: { error: "INVALID_IDENTITY_TOKEN" as const },
      };
    }

    const user = sanitizeAppleName({
      firstName: args.firstName,
      lastName: args.lastName,
    });
    const state = generateRandomToken();
    const code = generateRandomToken();
    await ctx.runMutation(internal.provider.createTicket, {
      stateHash: await sha256Hex(state),
      ticketCodeHash: await sha256Hex(code),
      encryptedPayload: await encryptTicketPayload(
        code,
        JSON.stringify({
          claims,
          callbackParams: user === undefined ? undefined : { user },
        } satisfies TicketPayload),
      ),
    });
    return { status: "exchanged" as const, code, state };
  },
});
