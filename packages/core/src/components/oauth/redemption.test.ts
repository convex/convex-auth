import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  makeFunctionReference,
  mutationGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import type { PropertyValidators } from "convex/values";
import { api, internal } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import type { DataModel } from "./_generated/dataModel.ts";
import schema from "./schema.ts";
import { setupOauth, type OauthProfile } from "../../methods/oauth/server.ts";
import {
  asComponentApi,
  fakeCallbacks,
} from "../../lib/oauth/componentContract.fixture.ts";
import {
  encryptTicketPayload,
  generateRandomToken,
} from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import type {
  AuthClaims,
  BoundAuthHelpers,
  TokenBundle,
} from "../../lib/types.ts";
import type {
  AuthCore,
  AuthMutationBuilder,
  MethodBuilders,
} from "../../server/setup.ts";

/**
 * Tests for the app-side `completeSignIn` mutation produced by `setupOauth`,
 * run against the real OAuth component. The core helpers on `ctx.convexAuth`
 * are fakes, and component/core.test.ts covers the real ones.
 */

/**
 * Calls to the fake `ctx.convexAuth.createUser` / `completeSignIn`.
 * The suite runs in one process, so tests read and reset this directly. A
 * `signIn` call also records the accounts that existed when it ran, so tests
 * can check that a new user's account is written before the app's `onSignIn`
 * would run.
 */
type HelperCall = {
  kind: "createUser" | "signIn";
  claims: AuthClaims;
  userId?: string;
  accountsAtSignIn?: { providerAccountId: string; userId: string }[];
};
const helperCalls: HelperCall[] = [];

/**
 * When set, the fake helpers throw this instead of returning a bundle, modeling
 * the app rejecting the sign-in from its `createUser` / `onSignIn` callback.
 */
const helperFailure = { error: undefined as Error | undefined };

/** The bundle the fake helpers mint on success. */
const bundle: TokenBundle = {
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  refreshTokenExpiresAt: 253402300800000,
  userId: "user-1",
};

/** The envelope a redemption that reached the helpers returns. */
const completed = { status: "complete", tokens: bundle };

/**
 * The envelope every unredeemable code returns: unknown, already spent,
 * expired, and mismatched state are one code by design.
 */
const invalidCode = { status: "error", userError: { error: "INVALID_CODE" } };

/** A fake core whose builders inject fake {@link BoundAuthHelpers}. */
const fakeCore = {
  bindMethod: <MethodName extends string, Profile>({
    name,
  }: {
    name: MethodName;
  }): MethodBuilders<Profile> => {
    const makeConvexAuth = (
      ctx: GenericMutationCtx<GenericDataModel>,
    ): BoundAuthHelpers<Profile> => ({
      createUser: async ({ profile }) => {
        helperCalls.push({
          kind: "createUser",
          claims: { method: name, profile },
        });
        if (helperFailure.error !== undefined) {
          throw helperFailure.error;
        }
        return { userId: bundle.userId };
      },
      completeSignIn: async ({ userId, profile }) => {
        // The fake core runs against the component's own schema.
        const db = (ctx as unknown as GenericMutationCtx<DataModel>).db;
        const accountsAtSignIn = (await db.query("accounts").collect()).map(
          ({ providerAccountId, userId }) => ({ providerAccountId, userId }),
        );
        helperCalls.push({
          kind: "signIn",
          claims: { method: name, profile },
          userId,
          accountsAtSignIn,
        });
        if (helperFailure.error !== undefined) {
          throw helperFailure.error;
        }
        return bundle;
      },
      revokeOtherSessions: async () => {
        throw new Error("revokeOtherSessions is not used by redemption");
      },
      revokeAllSessions: async () => {
        throw new Error("revokeAllSessions is not used by redemption");
      },
    });
    const authMutation: AuthMutationBuilder<Profile> = (fn) =>
      mutationGeneric({
        args: fn.args as PropertyValidators,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler(
            { ...ctx, convexAuth: makeConvexAuth(ctx) },
            args as Parameters<typeof fn.handler>[1],
          ),
      });
    return { authMutation };
  },
} as unknown as AuthCore;

/** Provider options for every instance under test. */
const options = {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ["https://app.example.com"],
};

/** An OIDC-style catalog whose profile maps id_token claims (like Google). */
const claimsCatalog = {
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  issuer: "https://provider.example",
  scopes: ["openid"],
  profile: ((claims) => ({
    id: claims!.sub,
    email: claims?.email,
    name: claims?.name,
  })) satisfies OauthProfile,
};

/**
 * A plain-OAuth catalog whose profile reads typed userinfo responses (like
 * GitHub), exercising the `UserInfo` generic end to end.
 */
const userInfoCatalog = {
  authorizationEndpoint: "https://provider.example/authorize",
  tokenEndpoint: "https://provider.example/token",
  userInfoEndpoints: { user: "https://provider.example/user" },
  scopes: [],
  profile: ((_claims, userInfoResponses) => ({
    id: String(userInfoResponses!.user.id),
    login: userInfoResponses!.user.login,
  })) satisfies OauthProfile<
    { id: string; login: string },
    { user: { id: number; login: string } }
  >,
};

/** A catalog whose profile mapping returns an empty id. */
const emptyIdCatalog = {
  ...claimsCatalog,
  profile: (() => ({ id: "" })) satisfies OauthProfile,
};

/**
 * A catalog whose profile mapping omits the id entirely, modeling an untyped
 * (plain JS) mapping. `OauthProfile`'s return type makes this unwritable
 * directly, so the cast fakes it.
 */
const missingIdCatalog = {
  ...claimsCatalog,
  profile: (() => ({})) as unknown as OauthProfile,
};

/**
 * The app-side functions under test, named statically the way a catalog
 * module names them. They aren't component modules (in a real deployment
 * they live in the app), so they can't come from the module glob. Instead
 * they're injected below as a synthetic `testApp` module, which convex-test
 * invokes like any registered function (argument and return validation,
 * transactions, and all). A real testApp.ts in this directory would leak
 * public mutations into the component's generated API.
 */
const testApp = {
  completeSignInWithAcme: setupOauth(
    fakeCore,
    "acme",
    claimsCatalog,
    fakeCallbacks,
    options,
  ).completeSignIn,
  completeSignInWithAcmeInfo: setupOauth(
    fakeCore,
    "acmeInfo",
    userInfoCatalog,
    fakeCallbacks,
    options,
  ).completeSignIn,
  completeSignInEmptyId: setupOauth(
    fakeCore,
    "emptyId",
    emptyIdCatalog,
    fakeCallbacks,
    options,
  ).completeSignIn,
  completeSignInMissingId: setupOauth(
    fakeCore,
    "missingId",
    missingIdCatalog,
    fakeCallbacks,
    options,
  ).completeSignIn,
};

const modules = {
  ...import.meta.glob("./**/*.ts"),
  "./testApp.ts": async () => testApp,
};

const completeSignInWithAcme = makeFunctionReference<"mutation">(
  "testApp:completeSignInWithAcme",
);
const completeSignInWithAcmeInfo = makeFunctionReference<"mutation">(
  "testApp:completeSignInWithAcmeInfo",
);
const completeSignInEmptyId = makeFunctionReference<"mutation">(
  "testApp:completeSignInEmptyId",
);
const completeSignInMissingId = makeFunctionReference<"mutation">(
  "testApp:completeSignInMissingId",
);

function setup() {
  return convexTest(schema, modules);
}

/** Valid id_token claims for the acme provider's payloads. */
const validClaims = {
  sub: "acme-sub-1",
  email: "ada@example.com",
  name: "Ada",
};

/**
 * Mint a ticket with real crypto: real ticket code, hashes, and payload
 * encryption. Returns the raw code, which is what the client presents at
 * redemption.
 */
async function mintTicket(
  t: ReturnType<typeof setup>,
  args: {
    providerName?: string;
    state?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  const ticketCode = generateRandomToken();
  await t.mutation(internal.provider.createTicket, {
    providerName: args.providerName ?? "acme",
    stateHash: await sha256Hex(args.state ?? "state-1"),
    ticketCodeHash: await sha256Hex(ticketCode),
    encryptedPayload: await encryptTicketPayload(
      ticketCode,
      JSON.stringify(args.payload ?? { claims: validClaims }),
    ),
  });
  return ticketCode;
}

/** Get the component's accounts without system fields. */
async function accounts(t: ReturnType<typeof setup>) {
  return (
    await t.run(async (ctx) => await ctx.db.query("accounts").collect())
  ).map(({ providerAccountId, userId }) => ({ providerAccountId, userId }));
}

afterEach(() => {
  vi.useRealTimers();
  helperCalls.length = 0;
  helperFailure.error = undefined;
});

describe("completeSignIn", () => {
  test("redeems a minted ticket into a session via the profile mapping", async () => {
    const t = setup();
    const code = await mintTicket(t);

    const result = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });

    expect(result).toEqual(completed);
    // The decrypted payload flowed through the catalog's profile mapping
    // into the fake helpers. The identity is unknown to the component, so
    // redemption created a user, recorded its account, and only then signed
    // it in...
    const claims = {
      method: "acme",
      profile: { id: "acme-sub-1", email: "ada@example.com", name: "Ada" },
    };
    expect(helperCalls).toEqual([
      { kind: "createUser", claims },
      {
        kind: "signIn",
        claims,
        userId: bundle.userId,
        accountsAtSignIn: [
          { providerAccountId: "acme-sub-1", userId: bundle.userId },
        ],
      },
    ]);
    // ...and recorded an account for the new user.
    expect(await accounts(t)).toEqual([
      { providerAccountId: "acme-sub-1", userId: bundle.userId },
    ]);
  });

  test("signs a returning identity in rather than signing it up again", async () => {
    const t = setup();
    const code = await mintTicket(t);

    // The identity already has an account.
    await t.mutation(api.provider._internal_dangerous_createAccount, {
      providerAccountId: "acme-sub-1",
      userId: "user-7",
    });
    const result = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });

    expect(result).toEqual(completed);
    expect(helperCalls).toEqual([
      {
        kind: "signIn",
        userId: "user-7",
        claims: {
          method: "acme",
          profile: { id: "acme-sub-1", email: "ada@example.com", name: "Ada" },
        },
        accountsAtSignIn: [
          { providerAccountId: "acme-sub-1", userId: "user-7" },
        ],
      },
    ]);
    expect(await accounts(t)).toHaveLength(1);
  });

  test("passes userinfo responses to the profile mapping", async () => {
    const t = setup();
    const code = await mintTicket(t, {
      providerName: "acmeInfo",
      payload: { userInfoResponses: { user: { id: 42, login: "octocat" } } },
    });

    const result = await t.mutation(completeSignInWithAcmeInfo, {
      code,
      state: "state-1",
    });

    expect(result).toEqual(completed);
    const claims = {
      method: "acmeInfo",
      profile: { id: "42", login: "octocat" },
    };
    expect(helperCalls).toEqual([
      { kind: "createUser", claims },
      {
        kind: "signIn",
        claims,
        userId: bundle.userId,
        accountsAtSignIn: [{ providerAccountId: "42", userId: bundle.userId }],
      },
    ]);
  });

  test("an unknown code reports INVALID_CODE", async () => {
    const t = setup();
    const result = await t.mutation(completeSignInWithAcme, {
      code: "never-minted",
      state: "state-1",
    });
    expect(result).toEqual(invalidCode);
    expect(helperCalls).toHaveLength(0);
  });

  test("a wrong state reports INVALID_CODE and preserves the ticket", async () => {
    const t = setup();
    const code = await mintTicket(t);

    const mismatched = await t.mutation(completeSignInWithAcme, {
      code,
      state: "someone-elses-state",
    });
    expect(mismatched).toEqual(invalidCode);

    // The ticket survives a mismatched attempt, so the initiating client can
    // still complete.
    const result = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });
    expect(result).toEqual(completed);
  });

  test("a code redeems exactly once", async () => {
    const t = setup();
    const code = await mintTicket(t);

    const first = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });
    expect(first).toEqual(completed);

    const second = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });
    expect(second).toEqual(invalidCode);
    // Only the first redemption reached the helpers: one sign-up and its
    // sign-in.
    expect(helperCalls).toHaveLength(2);
  });

  test("an expired ticket reports INVALID_CODE", async () => {
    vi.useFakeTimers();
    const t = setup();
    const code = await mintTicket(t);
    vi.advanceTimersByTime(3 * 60 * 1000); // well past the ticket TTL

    const result = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });
    expect(result).toEqual(invalidCode);
    expect(helperCalls).toHaveLength(0);
  });

  test("a profile mapping that returns an empty id throws", async () => {
    const t = setup();
    const code = await mintTicket(t, { providerName: "emptyId" });

    await expect(
      t.mutation(completeSignInEmptyId, { code, state: "state-1" }),
    ).rejects.toThrow(/returned no id/);
  });

  test("a profile mapping that omits the id throws", async () => {
    const t = setup();
    const code = await mintTicket(t, { providerName: "missingId" });

    await expect(
      t.mutation(completeSignInMissingId, { code, state: "state-1" }),
    ).rejects.toThrow(/returned no id/);
  });

  test("an app rejection rolls back the ticket claim", async () => {
    const t = setup();
    const code = await mintTicket(t);

    // The app rejects the sign-in...
    helperFailure.error = new Error("sign-ups are closed");
    await expect(
      t.mutation(completeSignInWithAcme, { code, state: "state-1" }),
    ).rejects.toThrow("sign-ups are closed");

    // ...and the claim rolled back with the rest of the mutation, so the
    // ticket is not burned by the failed attempt.
    helperFailure.error = undefined;
    const result = await t.mutation(completeSignInWithAcme, {
      code,
      state: "state-1",
    });
    expect(result).toEqual(completed);
  });
});
