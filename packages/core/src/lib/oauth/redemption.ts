/**
 * The app-side end of an OAuth flow: redeeming the one-time code the callback
 * redirected back with, and the option validation every provider setup runs
 * first.
 *
 * @module
 */
import { Infer, v } from "convex/values";
import type { GenericDataModel, GenericMutationCtx } from "convex/server";
import { vSignInComplete, vSignInError } from "../types.ts";
import type { AuthMutationBuilder } from "../../server/setup.ts";
import { decryptTicketPayload } from "./crypto.ts";
import { sha256Hex } from "../crypto.ts";

/**
 * Standard OIDC id_token claims. The well-known ones are typed. Any other
 * claim the provider includes is present but untyped (`unknown`).
 *
 * OIDC says `email_verified` is a boolean, and Apple sends the string
 * `"true"` for some accounts, so the type accepts both.
 */
export type OidcClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  [claim: string]: unknown;
};

/**
 * What the callback encrypted into the ticket, and redemption decrypts. Every
 * field is optional because which ones a provider produces depends on how it
 * attests identity:
 *
 * - `claims`: validated id_token claims, for a provider that returns one.
 * - `userInfoResponses`: the responses from the configured userinfo
 *   endpoints, keyed as configured.
 * - `callbackParams`: extra data the provider sent to the callback itself
 *   as a query or form field rather than through a token, already sanitized
 *   by the component that accepted it. It is browser-relayed and therefore
 *   user-controlled, unlike the other two.
 *
 * At least one of `claims` and `userInfoResponses` is always present: the
 * callback refuses a flow that produced neither.
 */
export type TicketPayload<
  UserInfo extends Record<string, unknown> = Record<string, unknown>,
> = {
  claims?: OidcClaims;
  userInfoResponses?: UserInfo;
  callbackParams?: Record<string, unknown>;
};

/** `new URL` without the exception: returns null on unparseable input. */
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Check the origins a provider setup will accept as post-login destinations
 * and return them normalized. Called at setup so a mistake fails at deploy
 * time, not on the first sign-in.
 */
export function validateAllowedRedirectOrigins(
  allowedRedirectOrigins: string[],
): string[] {
  return allowedRedirectOrigins.map((allowed) => {
    const url = parseUrl(allowed);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:")
    ) {
      throw new Error(
        `allowedRedirectOrigins entry is not a valid http(s) origin: ` +
          `"${allowed}" (custom schemes like "myapp://" are not supported yet)`,
      );
    }
    // An entry with a path would silently allow the whole origin, which is
    // broader than what the config appears to say. Require bare origins.
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error(
        `allowedRedirectOrigins entry must be a bare origin with no path, ` +
          `query, or fragment: "${allowed}" (use "${url.origin}" to allow ` +
          `the whole origin)`,
      );
    }
    return url.origin;
  });
}

/** The ctx a redemption handler runs with, before the core's helpers. */
type MutationCtx = GenericMutationCtx<GenericDataModel>;

const completeSignInResult = v.union(
  vSignInComplete,
  // The one-time code did not redeem: unknown, already spent, expired, or
  // paired with a state this browser never held. The server cannot tell those
  // apart and deliberately does not try, so they share one code.
  vSignInError(v.object({ error: v.literal("INVALID_CODE") })),
);

/**
 * The result of `completeSignIn`.
 *
 * When complete the minted session tokens, otherwise a user-facing `userError`.
 */
export type CompleteSignInResult = Infer<typeof completeSignInResult>;

/** The result of a component's `redeemTicket`. */
export type RedeemedTicket =
  | null
  | {
      kind: "existing";
      payload: string;
      providerAccountId: string;
      attestation: string;
    }
  | { kind: "new"; payload: string; providerAccountId: string };

/**
 * Build a provider's `completeSignIn` mutation.
 *
 * The client presents the one-time code from the callback redirect together
 * with the state it has held since sign-in started. The component of the
 * provider redeems the ticket: it decrypts the identity that the provider
 * attested and derives the provider account id with its own fixed rule. The
 * code of the app does not choose the account.
 *
 * - If the component has an account for the identity, it attests the user of
 *   the account, and the core creates a session from that attestation.
 * - If not, the core creates a new user, the component links the identity to
 *   it and attests it, and the core creates a session.
 *
 * The profile mapping runs on the decrypted identity only to build the
 * profile that the app's `createUser` and `onSignIn` callbacks receive.
 *
 * Returns the shared sign-in envelope: the session token bundle, or an
 * `INVALID_CODE` error when the code is unknown, already redeemed, expired, or
 * the state doesn't match: all indistinguishable to the caller.
 *
 * The component calls are subtransactions of this mutation, so a failure
 * anywhere (including the app rejecting the sign-in from `createUser` /
 * `onSignIn`) rolls back the ticket claim and the account. Only a successful
 * redemption consumes the ticket.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export function buildAttestedCompleteSignIn<
  Profile extends { id: string },
  Payload extends TicketPayload = TicketPayload,
>(options: {
  /** The provider's name, for the error message when a mapping returns no id. */
  providerName: string;
  /** The core's method-bound mutation builder. */
  authMutation: AuthMutationBuilder<Profile>;
  /** Redeem the ticket in this provider's component instance. */
  redeemTicket: (
    ctx: MutationCtx,
    args: { ticketCode: string; state: string },
  ) => Promise<RedeemedTicket>;
  /** Link the identity of the redeemed ticket to a new user. */
  linkAccount: (
    ctx: MutationCtx,
    args: { ticketCode: string; newUser: string },
  ) => Promise<{ attestation: string }>;
  /** Map what the provider attested to the account profile. */
  profile: (payload: Payload) => Profile;
}) {
  return options.authMutation({
    args: {
      code: v.string(),
      state: v.string(),
    },
    returns: completeSignInResult,
    handler: async (ctx, args): Promise<CompleteSignInResult> => {
      const redeemed = await options.redeemTicket(ctx, {
        ticketCode: args.code,
        state: args.state,
      });
      if (redeemed === null) {
        return { status: "error", userError: { error: "INVALID_CODE" } };
      }

      const profile = options.profile(JSON.parse(redeemed.payload) as Payload);
      if (profile.id !== redeemed.providerAccountId) {
        // The mapping and the rule of the component must agree, or the app's
        // callbacks would see a different account than the component keeps.
        throw new Error(
          `Profile mapping for provider "${options.providerName}" returned ` +
            `an id that is not the account id of the component`,
        );
      }

      if (redeemed.kind === "existing") {
        const tokens = await ctx.convexAuth.createSession({
          attestation: redeemed.attestation,
          profile,
        });
        return { status: "complete", tokens };
      }
      const { newUser } = await ctx.convexAuth.createUser({
        profile,
      });
      const { attestation } = await options.linkAccount(ctx, {
        ticketCode: args.code,
        newUser,
      });
      const tokens = await ctx.convexAuth.createSession({
        attestation,
        profile,
      });
      return { status: "complete", tokens };
    },
  });
}

/**
 * Build a provider's `completeSignIn` mutation.
 *
 * The client presents the one-time code from the callback redirect together
 * with the state it has held since sign-in started. Both are hashed before
 * they reach the component, which claims the matching ticket, and the
 * identity payload is decrypted with a key derived from the raw code. The
 * profile mapping then turns what the provider attested into the account
 * identity. If the component has an account for the identity, the core signs
 * that user in. Otherwise the core creates a new app user, and the component
 * records an account for that user in the same mutation.
 *
 * Returns the shared sign-in envelope: the session token bundle, or an
 * `INVALID_CODE` error when the code is unknown, already redeemed, expired, or
 * the state doesn't match: all indistinguishable to the caller.
 *
 * The component calls are subtransactions of this mutation, so a failure
 * anywhere (including the app rejecting the sign-in from `createUser` /
 * `onSignIn`) rolls back the ticket claim and the account. Only a successful
 * redemption consumes the ticket.
 *
 * @internal Not public until the API for custom methods is stable.
 */
export function buildCompleteSignIn<
  Profile extends { id: string },
  Payload extends TicketPayload = TicketPayload,
>(options: {
  /** The provider's name, for the error message when a mapping returns no id. */
  providerName: string;
  /** The core's method-bound mutation builder. */
  authMutation: AuthMutationBuilder<Profile>;
  /**
   * The component of the provider, for example `components.authGoogle`. The
   * sessions record its path.
   */
  component: object;
  /** Claim the ticket in this provider's component instance. */
  claimTicket: (
    ctx: MutationCtx,
    args: { ticketCodeHash: string; stateHash: string },
  ) => Promise<{ encryptedPayload: string } | null>;
  /**
   * Get the app user id connected to a given provider account id in this
   * provider's component, or `null` if there is none.
   */
  getUserIdByAccount: (
    ctx: MutationCtx,
    args: { providerAccountId: string },
  ) => Promise<string | null>;
  /** Create an account connecting a provider account id to an app user id. */
  createAccount: (
    ctx: MutationCtx,
    args: { providerAccountId: string; userId: string },
  ) => Promise<null>;
  /** Map what the provider attested to the account profile. */
  profile: (payload: Payload) => Profile;
}) {
  return options.authMutation({
    args: {
      code: v.string(),
      state: v.string(),
    },
    returns: completeSignInResult,
    handler: async (ctx, args): Promise<CompleteSignInResult> => {
      const ticket = await options.claimTicket(ctx, {
        ticketCodeHash: await sha256Hex(args.code),
        stateHash: await sha256Hex(args.state),
      });
      if (ticket === null) {
        return { status: "error", userError: { error: "INVALID_CODE" } };
      }

      // Finding the ticket by hash proves `code` is the value the payload was
      // encrypted under, so decryption only fails on corruption.
      const payload = JSON.parse(
        await decryptTicketPayload(args.code, ticket.encryptedPayload),
      ) as Payload;

      const profile = options.profile(payload);
      if (typeof profile.id !== "string" || profile.id === "") {
        throw new Error(
          `Profile mapping for provider "${options.providerName}" returned no id`,
        );
      }

      // The same redemption flow serves a first sign-in and a return visit, so
      // look the identity up to pick a path. The lookup and the writes share
      // one transaction, so concurrent first redemptions of one identity
      // create only one user.
      const existingUserId = await options.getUserIdByAccount(ctx, {
        providerAccountId: profile.id,
      });
      if (existingUserId !== null) {
        const tokens = await ctx.convexAuth.completeSignIn({
          userId: existingUserId,
          profile,
          verifiedBy: options.component,
        });
        return { status: "complete", tokens };
      }
      const tokens = await ctx.convexAuth.completeSignUp({
        profile,
        verifiedBy: options.component,
      });
      await options.createAccount(ctx, {
        providerAccountId: profile.id,
        userId: tokens.userId,
      });
      return { status: "complete", tokens };
    },
  });
}
