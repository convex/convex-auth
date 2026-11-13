/**
 * Tests native Google sign-in end to end: an app with the core and the Google
 * component installed exchanges an id_token from Google's native SDK and
 * redeems the result with `completeSignInWithGoogle`, the redemption the web
 * flow uses.
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
import type { ComponentApi as GoogleComponentApi } from "../../components/google/_generated/component.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import type { CreateUserFn, TokenBundle } from "../../lib/types.ts";
import { setupConvexAuth } from "../../server/setup.ts";
import { registerCore } from "../../testing/core.ts";
import { registerGoogleOauth } from "../../testing/google.ts";
import { setupGoogle, type GoogleProfile } from "./server.ts";

const CLIENT_ID = "1234-ios.apps.googleusercontent.com";
const KEY_ID = "google-key-1";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const NONCE = "6f1c2a0e-5b7d-4e8a-9c3f-2d1b0a9e8f7c";
const GOOGLE_SUB = "110169484474386276334";

const components = componentsGeneric() as unknown as {
  auth: CoreComponentApi<"auth">;
  authGoogle: GoogleComponentApi<"authGoogle">;
};

/**
 * The app's user-creating callback. It echoes the Google account id back as
 * the user id, with the name it was given.
 */
const createUser = internalMutationGeneric({
  args: {
    method: v.object({ name: v.string(), profile: v.any() }),
  },
  returns: v.string(),
  handler: async (_ctx, args) =>
    `${args.method.profile.id}:${args.method.profile.name ?? "no name"}`,
});

const googleOptions = {
  component: components.authGoogle,
  allowedRedirectOrigins: ["https://app.example.com"],
};
const createUserRef = makeFunctionReference<"mutation">(
  "testApp:createUser",
) as unknown as CreateUserFn<"google", GoogleProfile, "users">;

function appWith(options: Partial<Parameters<typeof setupGoogle>[1]>) {
  return {
    createUser,
    ...setupGoogle(setupConvexAuth({ component: components.auth }), {
      ...googleOptions,
      ...options,
    }).attachUserCallbacks({ createUser: createUserRef }),
  };
}

const testApp = appWith({ nativeAppClientIds: [CLIENT_ID] });

function setup(app: object = testApp) {
  vi.stubEnv("CLIENT_ID", "1234-web.apps.googleusercontent.com");
  vi.stubEnv("CLIENT_SECRET", "web-secret");
  const t = convexTest(undefined, {
    "./_generated/api.ts": async () => ({}),
    "./testApp.ts": async () => app,
  });
  registerCore(t);
  registerGoogleOauth(t);
  return t;
}

const exchangeRef = makeFunctionReference<
  "action",
  { idToken: string; nonce?: string },
  | { status: "exchanged"; code: string; state: string }
  | { status: "error"; userError: { error: "INVALID_ID_TOKEN" } }
>("testApp:exchangeGoogleIdToken");

const completeSignInRef = makeFunctionReference<
  "mutation",
  { code: string; state: string },
  { status: "complete"; tokens: TokenBundle }
>("testApp:completeSignInWithGoogle");

let googleKey: KeyLike;

beforeAll(async () => {
  const google = await generateKeyPair("RS256", { extractable: true });
  googleKey = google.privateKey;
  const jwk = { ...(await exportJWK(google.publicKey)), kid: KEY_ID };
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

/** An id_token as Google's native SDK hands it to the app. */
async function idToken(claims: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: GOOGLE_SUB,
    iat: now,
    exp: now + 3600,
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    nonce: await sha256Hex(NONCE),
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .sign(googleKey);
}

/** Sign in from the app: exchange the token, then redeem the result. */
async function signInNatively(
  t: ReturnType<typeof setup>,
  args: { idToken: string; nonce?: string },
) {
  const exchanged = await t.action(exchangeRef, args);
  if (exchanged.status !== "exchanged") {
    throw new Error(`Expected a ticket, got ${JSON.stringify(exchanged)}`);
  }
  return await t.mutation(completeSignInRef, {
    code: exchanged.code,
    state: exchanged.state,
  });
}

describe("exchangeGoogleIdToken", () => {
  test("signs up with the profile of the token, then signs the same user in", async () => {
    const t = setup();
    const first = await signInNatively(t, {
      idToken: await idToken(),
      nonce: NONCE,
    });
    expect(first.status).toBe("complete");
    expect(first.tokens.userId).toBe(`${GOOGLE_SUB}:Ada Lovelace`);

    const second = await signInNatively(t, {
      idToken: await idToken(),
      nonce: NONCE,
    });
    expect(second.tokens.userId).toBe(first.tokens.userId);
  });

  test("a ticket redeems once", async () => {
    const t = setup();
    const exchanged = await t.action(exchangeRef, {
      idToken: await idToken(),
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

  test("requires a nonce unless the method allows tokens without one", async () => {
    const tokenWithoutNonce = await idToken({ nonce: undefined });
    await expect(
      setup().action(exchangeRef, { idToken: tokenWithoutNonce }),
    ).rejects.toThrow("allowIdTokensWithoutNonce");

    const t = setup(
      appWith({
        nativeAppClientIds: [CLIENT_ID],
        allowIdTokensWithoutNonce: true,
      }),
    );
    const result = await signInNatively(t, { idToken: tokenWithoutNonce });
    expect(result.status).toBe("complete");
  });

  test("throws when the method accepts no native apps", async () => {
    const t = setup(appWith({}));
    await expect(
      t.action(exchangeRef, { idToken: await idToken(), nonce: NONCE }),
    ).rejects.toThrow("nativeAppClientIds");
  });
});

describe("setupGoogle", () => {
  test("rejects a native app client id that is not one at setup", () => {
    expect(() => appWith({ nativeAppClientIds: ["com.example.app"] })).toThrow(
      "not a Google OAuth client id",
    );
  });
});
