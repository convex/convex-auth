/**
 * Tests native Sign in with Apple end to end: an app with the core and the
 * Apple component installed exchanges an identity token from the system sheet
 * and redeems the result with `completeSignInWithApple`, the redemption the
 * web flow uses.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  componentsGeneric,
  internalMutationGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ComponentApi as CoreComponentApi } from "../../component/_generated/component.ts";
import type { ComponentApi as AppleComponentApi } from "../../components/apple/_generated/component.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import type { CreateUserFn, TokenBundle } from "../../lib/types.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { registerAppleOauth } from "../../testing/apple.ts";
import { registerCore } from "../../testing/core.ts";
import { setupApple, type AppleProfile } from "./server.ts";

const BUNDLE_ID = "com.example.app";
const KEY_ID = "apple-key-1";
const JWKS_ENDPOINT = "https://appleid.apple.com/auth/keys";
const NONCE = "6f1c2a0e-5b7d-4e8a-9c3f-2d1b0a9e8f7c";
const APPLE_SUB = "001234.abcdef.0123";

const components = componentsGeneric() as unknown as {
  auth: CoreComponentApi<"auth">;
  authApple: AppleComponentApi<"authApple">;
};

/**
 * The app's user-creating callback. It echoes the Apple account id back as
 * the user id, and records the name it was given.
 */
const createUser = internalMutationGeneric({
  args: {
    method: v.object({ name: v.string(), profile: v.any() }),
  },
  returns: v.string(),
  handler: async (_ctx, args) =>
    `${args.method.profile.id}:${args.method.profile.name ?? "no name"}`,
});

const auth = setupConvexAuth({ component: components.auth });

const appleOptions = {
  component: components.authApple,
  allowedRedirectOrigins: ["https://app.example.com"],
};
const createUserRef = makeFunctionReference<"mutation">(
  "testApp:createUser",
) as unknown as CreateUserFn<"apple", AppleProfile, "users">;

const testApp = {
  createUser,
  ...setupApple(auth, {
    ...appleOptions,
    nativeAppBundleIds: [BUNDLE_ID],
  }).attachUserCallbacks({ createUser: createUserRef }),
};

/** The same method without native apps configured. */
const webOnlyApp = {
  createUser,
  ...setupApple(
    setupConvexAuth({ component: components.auth }),
    appleOptions,
  ).attachUserCallbacks({ createUser: createUserRef }),
};

function setup(app: object = testApp) {
  vi.stubEnv("CLIENT_ID", "com.example.app.web");
  const t = convexTest(undefined, {
    "./_generated/api.ts": async () => ({}),
    "./testApp.ts": async () => app,
  });
  registerCore(t);
  registerAppleOauth(t);
  return t;
}

const exchangeRef = makeFunctionReference<
  "action",
  {
    identityToken: string;
    nonce: string;
    firstName?: string;
    lastName?: string;
  },
  | { status: "exchanged"; code: string; state: string }
  | { status: "error"; userError: { error: "INVALID_IDENTITY_TOKEN" } }
>("testApp:exchangeAppleIdentityToken");

const completeSignInRef = makeFunctionReference<
  "mutation",
  { code: string; state: string },
  { status: "complete"; tokens: TokenBundle }
>("testApp:completeSignInWithApple");

let appleKey: KeyLike;

beforeAll(async () => {
  const apple = await generateKeyPair("RS256", { extractable: true });
  appleKey = apple.privateKey;
  const jwk = { ...(await exportJWK(apple.publicKey)), kid: KEY_ID };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== JWKS_ENDPOINT) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return new Response(JSON.stringify({ keys: [jwk] }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** An identity token as the system sheet hands it to the app. */
async function identityToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: "https://appleid.apple.com",
    aud: BUNDLE_ID,
    sub: APPLE_SUB,
    iat: now,
    exp: now + 600,
    email: "ada@privaterelay.appleid.com",
    email_verified: true,
    nonce: await sha256Hex(NONCE),
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .sign(appleKey);
}

/** Sign in from the app: exchange the token, then redeem the result. */
async function signInNatively(
  t: ReturnType<typeof setup>,
  name: { firstName?: string; lastName?: string } = {},
) {
  const exchanged = await t.action(exchangeRef, {
    identityToken: await identityToken(),
    nonce: NONCE,
    ...name,
  });
  if (exchanged.status !== "exchanged") {
    throw new Error(`Expected a ticket, got ${JSON.stringify(exchanged)}`);
  }
  return await t.mutation(completeSignInRef, {
    code: exchanged.code,
    state: exchanged.state,
  });
}

describe("exchangeAppleIdentityToken", () => {
  test("signs up with the name from the first authorization, then signs the same user in", async () => {
    const t = setup();
    const first = await signInNatively(t, {
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(first.status).toBe("complete");
    expect(first.tokens.userId).toBe(`${APPLE_SUB}:Ada Lovelace`);

    // Apple sends no name on a return visit, and the account is found by sub.
    const second = await signInNatively(t);
    expect(second.tokens.userId).toBe(first.tokens.userId);
  });

  test("a ticket redeems once", async () => {
    const t = setup();
    const exchanged = await t.action(exchangeRef, {
      identityToken: await identityToken(),
      nonce: NONCE,
    });
    if (exchanged.status !== "exchanged") {
      throw new Error(`Expected a ticket, got ${JSON.stringify(exchanged)}`);
    }
    const ticket = { code: exchanged.code, state: exchanged.state };
    expect((await t.mutation(completeSignInRef, ticket)).status).toBe(
      "complete",
    );
    expect(await t.mutation(completeSignInRef, ticket)).toEqual({
      status: "error",
      userError: { error: "INVALID_CODE" },
    });
  });

  test("throws when the method accepts no native apps", async () => {
    const t = setup(webOnlyApp);
    await expect(
      t.action(exchangeRef, {
        identityToken: await identityToken(),
        nonce: NONCE,
      }),
    ).rejects.toThrow("nativeAppBundleIds");
  });
});

describe("setupApple", () => {
  test("rejects a native app bundle id that is not one at setup", () => {
    expect(() =>
      setupApple(auth, {
        ...appleOptions,
        nativeAppBundleIds: ["https://app.example.com"],
      }),
    ).toThrow("not a bundle id");
  });
});
