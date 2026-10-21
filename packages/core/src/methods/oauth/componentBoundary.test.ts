/**
 * Tests that each OAuth provider's `startSignIn` and `completeSignIn` reach
 * their component through the `component` option the app passes in.
 *
 * Most OAuth tests use `asComponentApi` and run the component as the test's
 * root. A test there passes even if the code ignores the `component` option
 * and calls the component's own generated `api`. That code breaks in a real
 * app, where those references point at the app's own modules. These tests
 * run as an app with the components installed, so that mistake fails here.
 *
 * TODO(erquhart) Remove this file when every provider has `startSignIn` and
 * `completeSignIn` tests that run from an app root.
 *
 * @module
 */
import { convexTest } from "convex-test";
import { componentsGeneric, makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerAppleOauth } from "../../testing/apple.ts";
import { registerGithubOauth } from "../../testing/github.ts";
import { registerGoogleOauth } from "../../testing/google.ts";
import { registerOauth } from "../../testing/oauth.ts";
import type { ComponentApi as AppleComponentApi } from "../../components/apple/_generated/component.ts";
import { setupApple } from "../apple/server.ts";
import type { ComponentApi as OauthComponentApi } from "../../components/oauth/_generated/component.ts";
import { setupOauth } from "./server.ts";
import type { ComponentApi as GithubComponentApi } from "../../components/github/_generated/component.ts";
import { setupGithub } from "../github/server.ts";
import type { ComponentApi as GoogleComponentApi } from "../../components/google/_generated/component.ts";
import { setupGoogle } from "../google/server.ts";
import {
  ALLOWED_ORIGINS,
  fakeCore,
} from "../../lib/oauth/componentContract.test.ts";
import { CALLBACK_PATH } from "../../lib/oauth/constants.ts";

const CLIENT_ID = "test-client-id";
const SITE_URL = "https://test.convex.site/oauth/test-provider";
const CALLBACK_URL = `${SITE_URL}${CALLBACK_PATH}`;
const REDIRECT_TO = `${ALLOWED_ORIGINS[0]}/after`;

const components = componentsGeneric() as unknown as {
  authOauth: OauthComponentApi<"authOauth">;
  authApple: AppleComponentApi<"authApple">;
  authGithub: GithubComponentApi<"authGithub">;
  authGoogle: GoogleComponentApi<"authGoogle">;
};

const acme = setupOauth(
  fakeCore,
  "acme",
  {
    authorizationEndpoint: "https://provider.example/authorize",
    tokenEndpoint: "https://provider.example/token",
    scopes: [],
    profile: () => ({ id: "account-1" }),
  },
  { component: components.authOauth, allowedRedirectOrigins: ALLOWED_ORIGINS },
);

const testApp = {
  startSignInWithAcme: acme.startSignIn,
  completeSignInWithAcme: acme.completeSignIn,
  ...setupApple(fakeCore, {
    component: components.authApple,
    allowedRedirectOrigins: ALLOWED_ORIGINS,
  }),
  ...setupGithub(fakeCore, {
    component: components.authGithub,
    allowedRedirectOrigins: ALLOWED_ORIGINS,
  }),
  ...setupGoogle(fakeCore, {
    component: components.authGoogle,
    allowedRedirectOrigins: ALLOWED_ORIGINS,
  }),
};

/**
 * The app's modules. convex-test takes the root directory from the first path
 * that contains `_generated`, so the `_generated/api.ts` entry only has to
 * exist.
 */
const modules = {
  "./_generated/api.ts": async () => ({}),
  "./testApp.ts": async () => testApp,
};

/**
 * An app with all four components registered. The components read the
 * credentials their instance binds and the site URL from `process.env`, so
 * both are stubbed the way the backend would present them.
 */
function setup() {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL);
  const t = convexTest(undefined, modules);
  registerOauth(t);
  registerAppleOauth(t);
  registerGithubOauth(t);
  registerGoogleOauth(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  { component: "authOauth", provider: "Acme" },
  { component: "authApple", provider: "Apple" },
  { component: "authGithub", provider: "Github" },
  { component: "authGoogle", provider: "Google" },
])("the $component component", ({ provider }) => {
  const startSignIn = makeFunctionReference<
    "mutation",
    { redirectTo: string },
    { redirect: string; state: string }
  >(`testApp:startSignInWith${provider}`);
  const completeSignIn = makeFunctionReference<
    "mutation",
    { code: string; state: string },
    unknown
  >(`testApp:completeSignInWith${provider}`);

  test("startSignIn builds the redirect from what the component returns", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignIn, {
      redirectTo: REDIRECT_TO,
    });
    const params = new URL(redirect).searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(CALLBACK_URL);
  });

  test("completeSignIn looks up the ticket in the component", async () => {
    const t = setup();
    // No ticket was minted, so the component finds nothing to claim.
    expect(
      await t.mutation(completeSignIn, { code: "code-1", state: "state-1" }),
    ).toEqual({ status: "error", userError: { error: "INVALID_CODE" } });
  });
});
