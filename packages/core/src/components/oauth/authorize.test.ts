import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupOauth, type OauthCatalog } from "../../methods/oauth/server.ts";
import {
  asComponentApi,
  fakeCore,
} from "../../lib/oauth/componentContract.test.ts";
import { sha256Base64Url } from "../../lib/oauth/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";

/**
 * Tests for the shared `buildStartSignIn`, run through the app-side
 * `startSignIn` mutation that `setupOauth` produces against the real
 * component (real `createAuthorizationRequest`, real records). The built-in
 * providers build their authorization URL with the same function.
 */

const CLIENT_ID = "test-client-id";
const SITE_URL = "https://test.convex.site/oauth/acme";
const CALLBACK_URL = `${SITE_URL}/callback`;

const AUTHORIZATION_ENDPOINT = "https://provider.example/authorize";
const ALLOWED_ORIGINS = ["https://app.example.com"];
const REDIRECT_TO = "https://app.example.com/after";

/** Provider options for every instance under test. */
const options = {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
};

/** An OIDC catalog that asks for scopes (like Google). */
const scopedCatalog = {
  authorizationEndpoint: AUTHORIZATION_ENDPOINT,
  tokenEndpoint: "https://provider.example/token",
  issuer: "https://provider.example",
  scopes: ["openid", "email"],
  profile: () => ({ id: "account-1" }),
};

/** A catalog that asks for no scopes. */
const bareCatalog = {
  authorizationEndpoint: AUTHORIZATION_ENDPOINT,
  tokenEndpoint: "https://provider.example/token",
  scopes: [],
  profile: () => ({ id: "account-1" }),
};

/** A catalog whose provider delivers the callback with a POST. */
const formPostCatalog = {
  authorizationEndpoint: AUTHORIZATION_ENDPOINT,
  tokenEndpoint: "https://provider.example/token",
  scopes: [],
  callbackMethod: "POST",
  profile: () => ({ id: "account-1" }),
} satisfies OauthCatalog<{ id: string }>;

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
  startSignInScoped: setupOauth(fakeCore, "scoped", scopedCatalog, options)
    .startSignIn,
  startSignInBare: setupOauth(fakeCore, "bare", bareCatalog, options)
    .startSignIn,
  startSignInFormPost: setupOauth(
    fakeCore,
    "formPost",
    formPostCatalog,
    options,
  ).startSignIn,
};

const modules = {
  ...import.meta.glob("./**/*.ts"),
  "./testApp.ts": async () => testApp,
};

type StartSignInArgs = { redirectTo: string };
type StartSignInResult = { redirect: string; state: string };

const startSignInScoped = makeFunctionReference<
  "mutation",
  StartSignInArgs,
  StartSignInResult
>("testApp:startSignInScoped");
const startSignInBare = makeFunctionReference<
  "mutation",
  StartSignInArgs,
  StartSignInResult
>("testApp:startSignInBare");
const startSignInFormPost = makeFunctionReference<
  "mutation",
  StartSignInArgs,
  StartSignInResult
>("testApp:startSignInFormPost");

function setup() {
  // One instance serving one provider: the component instance binds the
  // provider's credentials. convex-test doesn't emulate component env
  // bindings or the backend applying httpPrefix to CONVEX_SITE_URL, so the
  // component-side values are stubbed directly (CONVEX_SITE_URL with the
  // prefix already applied, as the backend would present it).
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL);
  return convexTest(schema, modules);
}

/** The authorization request the test stored, or null if it stored none. */
async function storedRequest(t: ReturnType<typeof setup>) {
  return await t.run(
    async (ctx) => await ctx.db.query("authorizationRequests").unique(),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startSignIn", () => {
  test("a redirectTo outside the allowed origins is rejected", async () => {
    const t = setup();
    await expect(
      t.mutation(startSignInScoped, {
        redirectTo: "https://evil.example.com/after",
      }),
    ).rejects.toThrow(/is not in allowedRedirectOrigins/);
    expect(await storedRequest(t)).toBeNull();
  });

  test("a redirectTo that isn't an absolute URL is rejected", async () => {
    const t = setup();
    await expect(
      t.mutation(startSignInScoped, { redirectTo: "/after" }),
    ).rejects.toThrow(/must be an absolute URL/);
    expect(await storedRequest(t)).toBeNull();
  });

  test("the redirect carries the flow parameters and the component's callback URL", async () => {
    const t = setup();
    const { redirect, state } = await t.mutation(startSignInScoped, {
      redirectTo: REDIRECT_TO,
    });

    const url = new URL(redirect);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(url.searchParams.get("state")).toBe(state);
  });

  test("a catalog with scopes sends them space separated", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignInScoped, {
      redirectTo: REDIRECT_TO,
    });
    expect(new URL(redirect).searchParams.get("scope")).toBe("openid email");
  });

  test("a catalog with no scopes sends no scope parameter", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignInBare, {
      redirectTo: REDIRECT_TO,
    });
    expect(new URL(redirect).searchParams.has("scope")).toBe(false);
  });

  test("the redirect carries an S256 challenge of the recorded verifier", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignInScoped, {
      redirectTo: REDIRECT_TO,
    });

    const params = new URL(redirect).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    const request = await storedRequest(t);
    expect(request?.codeVerifier).toEqual(expect.any(String));
    expect(params.get("code_challenge")).toBe(
      await sha256Base64Url(request!.codeVerifier),
    );
  });

  test("a catalog whose provider posts the callback asks for form_post", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignInFormPost, {
      redirectTo: REDIRECT_TO,
    });
    expect(new URL(redirect).searchParams.get("response_mode")).toBe(
      "form_post",
    );
  });

  test("a catalog whose provider redirects the callback sends no response_mode parameter", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignInBare, {
      redirectTo: REDIRECT_TO,
    });
    expect(new URL(redirect).searchParams.has("response_mode")).toBe(false);
  });

  test("the returned state hashes to the recorded state hash", async () => {
    const t = setup();
    const { state } = await t.mutation(startSignInScoped, {
      redirectTo: REDIRECT_TO,
    });

    const request = await storedRequest(t);
    expect(request?.stateHash).toBe(await sha256Hex(state));
    expect(request?.redirectTo).toBe(REDIRECT_TO);
  });
});
