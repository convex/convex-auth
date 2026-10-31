/**
 * The authorization URL WorkOS's `startSignInWithWorkos` builds, run against
 * WorkOS's own component.
 *
 * @module
 */
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.ts";
import type { ComponentApi } from "./_generated/component.ts";
import schema from "./schema.ts";
import { setupWorkos } from "../../methods/workos/server.ts";
import {
  ALLOWED_ORIGINS,
  asComponentApi,
  fakeCallbacks,
  fakeCore,
  testProviderFunctionsContract,
} from "../../lib/oauth/componentContract.test.ts";

const modules = import.meta.glob("./**/*.ts");

const { startSignInWithWorkos } = setupWorkos(fakeCore, {
  component: asComponentApi<ComponentApi>(api),
  allowedRedirectOrigins: ALLOWED_ORIGINS,
}).attachUserCallbacks(fakeCallbacks);

const startSignIn = makeFunctionReference<
  "mutation",
  {
    redirectTo: string;
    organizationId?: string;
    connectionId?: string;
    loginHint?: string;
    domainHint?: string;
  },
  { redirect: string; state: string }
>("testApp:startSignIn");

const REDIRECT_TO = "https://app.example.com/after";

function setup() {
  vi.stubEnv("CLIENT_ID", "client_1");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/workos");
  return convexTest(schema, {
    ...modules,
    "./testApp.ts": async () => ({ startSignIn: startSignInWithWorkos }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startSignInWithWorkos", () => {
  test("routes to an organization, with the hints", async () => {
    const t = setup();
    const { redirect, state } = await t.mutation(startSignIn, {
      redirectTo: REDIRECT_TO,
      organizationId: "org_1",
      loginHint: "ada@example.com",
      domainHint: "example.com",
    });
    const url = new URL(redirect);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.workos.com/sso/authorize",
    );
    const params = url.searchParams;
    expect(params.get("organization")).toBe("org_1");
    expect(params.get("connection")).toBeNull();
    expect(params.get("login_hint")).toBe("ada@example.com");
    expect(params.get("domain_hint")).toBe("example.com");
    expect(params.get("client_id")).toBe("client_1");
    expect(params.get("redirect_uri")).toBe(
      "https://test.convex.site/workos/callback",
    );
    expect(params.get("response_type")).toBe("code");
    expect(params.get("state")).toBe(state);
    expect(params.get("scope")).toBeNull();
    expect(params.get("provider")).toBeNull();
  });

  test("routes to a connection", async () => {
    const t = setup();
    const { redirect } = await t.mutation(startSignIn, {
      redirectTo: REDIRECT_TO,
      connectionId: "conn_1",
    });
    const params = new URL(redirect).searchParams;
    expect(params.get("connection")).toBe("conn_1");
    expect(params.get("organization")).toBeNull();
  });

  test.each([
    ["neither", {}],
    ["both", { organizationId: "org_1", connectionId: "conn_1" }],
    ["a malformed organization", { organizationId: "acme" }],
    ["a malformed connection", { connectionId: "org_1" }],
  ])("refuses %s, writing nothing", async (_name, routing) => {
    const t = setup();
    await expect(
      t.mutation(startSignIn, { redirectTo: REDIRECT_TO, ...routing }),
    ).rejects.toThrow();
    const requests = await t.run(
      async (ctx) => await ctx.db.query("authorizationRequests").collect(),
    );
    expect(requests).toEqual([]);
  });
});

describe("startSignInWithWorkos with options read at sign-in", () => {
  const appUrl = { current: "https://one.example.com" };
  const { startSignInWithWorkos: startAtAppUrl } = setupWorkos(fakeCore, {
    component: asComponentApi<ComponentApi>(api),
    allowedRedirectOrigins: () => [appUrl.current],
    callbackUrl: () => `${appUrl.current}/workos/callback`,
  }).attachUserCallbacks(fakeCallbacks);

  function setupAtAppUrl() {
    vi.stubEnv("CLIENT_ID", "client_1");
    vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site/workos");
    return convexTest(schema, {
      ...modules,
      "./testApp.ts": async () => ({ startSignIn: startAtAppUrl }),
    });
  }

  test("sends WorkOS back to the callback URL, and keeps it for the exchange", async () => {
    const t = setupAtAppUrl();
    appUrl.current = "https://one.example.com";
    const { redirect } = await t.mutation(startSignIn, {
      redirectTo: "https://one.example.com/after",
      organizationId: "org_1",
    });
    expect(new URL(redirect).searchParams.get("redirect_uri")).toBe(
      "https://one.example.com/workos/callback",
    );
    const requests = await t.run(
      async (ctx) => await ctx.db.query("authorizationRequests").collect(),
    );
    expect(requests.map((request) => request.callbackUrl)).toEqual([
      "https://one.example.com/workos/callback",
    ]);
  });

  test("reads the allowed origins when sign-in starts", async () => {
    const t = setupAtAppUrl();
    appUrl.current = "https://two.example.com";
    await expect(
      t.mutation(startSignIn, {
        redirectTo: "https://one.example.com/after",
        organizationId: "org_1",
      }),
    ).rejects.toThrow(/allowedRedirectOrigins/);
    const { redirect } = await t.mutation(startSignIn, {
      redirectTo: "https://two.example.com/after",
      organizationId: "org_1",
    });
    expect(new URL(redirect).searchParams.get("redirect_uri")).toBe(
      "https://two.example.com/workos/callback",
    );
  });
});

testProviderFunctionsContract(schema, modules);
