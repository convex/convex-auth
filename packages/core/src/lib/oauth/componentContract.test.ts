/**
 * The tests every OAuth provider built from the shared parts has to pass.
 *
 * A provider is two halves: a component holding the tables and mutations, and
 * app-side code that calls them. Types cover most of what the two halves owe
 * each other, but not the parts that are values: an argument validator, a
 * return validator, the set of methods a route is served over, and the
 * endpoint and scope constants a provider pins are all checked when the code
 * runs, not when it compiles. The helpers here run those against a real
 * component, and each provider's own suite calls the ones that apply to it.
 *
 * A caller passes its own `schema` and `modules` because `import.meta.glob`
 * only reads a literal pattern written at the call site.
 *
 * @module
 */
import { convexTest } from "convex-test";
import {
  actionGeneric,
  makeFunctionReference,
  mutationGeneric,
} from "convex/server";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthCore } from "../../server/setup.ts";
import { sha256Hex } from "../crypto.ts";
import type { buildStartSignIn } from "./authorize.ts";
import { CALLBACK_PATH } from "./constants.ts";
import { sha256Base64Url } from "./crypto.ts";
import type { CallbackMethod } from "./http.ts";

type ComponentSchema = SchemaDefinition<GenericSchema, boolean>;

/** A component's modules, as `import.meta.glob` produces them. */
type ComponentModules = Record<string, () => Promise<unknown>>;

const CALLBACK_METHODS: readonly CallbackMethod[] = ["GET", "POST"];

const CLIENT_ID = "test-client-id";
const SITE_URL = "https://test.convex.site/oauth/test-provider";
const CALLBACK_URL = `${SITE_URL}${CALLBACK_PATH}`;
const CODE_VERIFIER = "verifier-1";
const ENCRYPTED_PAYLOAD = "encrypted-payload-1";

const ALLOWED_ORIGIN = "https://app.example.com";

export const ALLOWED_ORIGINS = [ALLOWED_ORIGIN];

const REDIRECT_TO = `${ALLOWED_ORIGIN}/after`;

export const fakeCore = {
  bindProvider: () => ({
    authMutation: mutationGeneric,
    authAction: actionGeneric,
  }),
} as unknown as AuthCore;

/**
 * Type a component's own generated `api` as its `ComponentApi`, for tests that
 * run the component's modules at the root. `ComponentApi` types the
 * component's public functions as internal, because the app can only call them
 * from server code. Visibility only exists in the types, so the cast is safe.
 *
 * TODO(erquhart) Run the suites that use this from an app root, with the
 * component registered as a child, and remove this.
 */
export function asComponentApi<T>(generatedApi: unknown): T {
  return generatedApi as T;
}

/**
 * A harness over the caller's component. The component instance binds the
 * provider's credentials, and convex-test emulates neither those bindings nor
 * the backend applying `httpPrefix` to `CONVEX_SITE_URL`, so both are stubbed
 * the way the backend would present them.
 */
function setup(schema: ComponentSchema, modules: ComponentModules) {
  vi.stubEnv("CLIENT_ID", CLIENT_ID);
  vi.stubEnv("CONVEX_SITE_URL", SITE_URL);
  return convexTest(schema, modules);
}

/**
 * The four mutations, by the names Convex registers them under. They are
 * written out rather than taken from a generated `api`, because each
 * component generates its own and this runs against all of them.
 */
const createAuthorizationRequest = makeFunctionReference<
  "mutation",
  { stateHash: string; redirectTo: string; codeVerifier: string },
  { clientId: string; callbackUrl: string }
>("provider:createAuthorizationRequest");

const claimAuthorizationRequest = makeFunctionReference<
  "mutation",
  { stateHash: string },
  | null
  | { expired: true; redirectTo: string }
  | {
      expired: false;
      stateHash: string;
      redirectTo: string;
      callbackUrl: string;
      codeVerifier: string;
    }
>("provider:claimAuthorizationRequest");

const createTicket = makeFunctionReference<
  "mutation",
  { stateHash: string; ticketCodeHash: string; encryptedPayload: string },
  null
>("provider:createTicket");

const claimTicket = makeFunctionReference<
  "mutation",
  { ticketCodeHash: string; stateHash: string },
  null | { encryptedPayload: string }
>("provider:claimTicket");

/**
 * Run the four mutations a component built with `buildProviderFunctions`
 * registers, start to finish: record an authorization request, claim it, mint
 * a ticket, and redeem it. Every argument and every returned field goes
 * through the component's own validators, so a validator that no longer
 * matches the table it describes fails here.
 */
export function testProviderFunctionsContract(
  schema: ComponentSchema,
  modules: ComponentModules,
): void {
  describe("provider functions", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("a flow runs from recorded request to redeemed ticket", async () => {
      const t = setup(schema, modules);
      const stateHash = await sha256Hex("state-raw-1");
      const ticketCodeHash = await sha256Hex("ticket-code-1");

      expect(
        await t.mutation(createAuthorizationRequest, {
          stateHash,
          redirectTo: REDIRECT_TO,
          codeVerifier: CODE_VERIFIER,
        }),
      ).toEqual({ clientId: CLIENT_ID, callbackUrl: CALLBACK_URL });

      expect(
        await t.mutation(claimAuthorizationRequest, { stateHash }),
      ).toEqual({
        expired: false,
        stateHash,
        redirectTo: REDIRECT_TO,
        callbackUrl: CALLBACK_URL,
        codeVerifier: CODE_VERIFIER,
      });

      await t.mutation(createTicket, {
        stateHash,
        ticketCodeHash,
        encryptedPayload: ENCRYPTED_PAYLOAD,
      });
      expect(
        await t.mutation(claimTicket, { ticketCodeHash, stateHash }),
      ).toEqual({ encryptedPayload: ENCRYPTED_PAYLOAD });
    });

    test("a ticket does not redeem against a different state", async () => {
      const t = setup(schema, modules);
      const stateHash = await sha256Hex("state-raw-1");
      const ticketCodeHash = await sha256Hex("ticket-code-1");

      await t.mutation(createAuthorizationRequest, {
        stateHash,
        redirectTo: REDIRECT_TO,
        codeVerifier: CODE_VERIFIER,
      });
      await t.mutation(claimAuthorizationRequest, { stateHash });
      await t.mutation(createTicket, {
        stateHash,
        ticketCodeHash,
        encryptedPayload: ENCRYPTED_PAYLOAD,
      });

      expect(
        await t.mutation(claimTicket, {
          ticketCodeHash,
          stateHash: await sha256Hex("someone-elses-state"),
        }),
      ).toBeNull();
    });
  });
}

/**
 * Check that the component's callback route is served over exactly `methods`.
 * A method the provider really delivers the callback with, but the route does
 * not serve, answers every sign-in with a 404.
 */
export function testCallbackMethods(
  schema: ComponentSchema,
  modules: ComponentModules,
  methods: readonly CallbackMethod[] = ["GET"],
): void {
  describe("callback route", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("is served over the declared methods and no others", async () => {
      const t = setup(schema, modules);
      const served: CallbackMethod[] = [];
      for (const method of CALLBACK_METHODS) {
        // A served route answers a request with no parameters with a 400.
        const response = await t.fetch(CALLBACK_PATH, { method });
        if (response.status !== 404) {
          served.push(method);
        }
      }
      expect(served).toEqual(
        CALLBACK_METHODS.filter((method) => methods.includes(method)),
      );
    });
  });
}

type StartSignIn = ReturnType<typeof buildStartSignIn>;

/**
 * The mutation under test, by the name the synthetic module below registers
 * it under.
 */
const testAppStartSignIn = makeFunctionReference<
  "mutation",
  { redirectTo: string },
  { redirect: string; state: string }
>("testApp:startSignIn");

/**
 * Check the authorization URL a provider's `startSignIn` builds, run against
 * that provider's own component.
 *
 * `startSignIn` belongs to the app rather than the component, so it can't come
 * from the module glob. It is injected as a synthetic `testApp` module, which
 * convex-test invokes like any registered function, argument and return
 * validation included.
 *
 * Write `expected` out as literals, not the provider's own constants, so a
 * mistaken edit to a constant fails this test.
 */
export function testAuthorizationUrl(
  schema: ComponentSchema,
  modules: ComponentModules,
  startSignIn: StartSignIn,
  expected: {
    /** Where the browser is sent, with no query string. */
    authorizationEndpoint: string;
    /**
     * The `scope` parameter, space separated. Leave it out for a provider that
     * asks for no scopes.
     */
    scope?: string;
    /**
     * The `response_mode` parameter. Only needed for providers that post the
     * callback.
     */
    responseMode?: string;
  },
): void {
  describe("authorization URL", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("carries the flow parameters and the component's callback URL", async () => {
      const t = setup(schema, {
        ...modules,
        "./testApp.ts": async () => ({ startSignIn }),
      });
      const { redirect, state } = await t.mutation(testAppStartSignIn, {
        redirectTo: REDIRECT_TO,
      });

      const url = new URL(redirect);
      expect(`${url.origin}${url.pathname}`).toBe(
        expected.authorizationEndpoint,
      );
      const params = url.searchParams;
      expect(params.get("response_type")).toBe("code");
      expect(params.get("client_id")).toBe(CLIENT_ID);
      expect(params.get("redirect_uri")).toBe(CALLBACK_URL);
      expect(params.get("state")).toBe(state);
      expect(params.get("scope")).toBe(expected.scope ?? null);
      expect(params.get("response_mode")).toBe(expected.responseMode ?? null);

      // The row is only there if startSignIn reached the component through the
      // mutation reference it was handed.
      const request = await t.run(
        async (ctx) => await ctx.db.query("authorizationRequests").unique(),
      );
      expect(request?.stateHash).toBe(await sha256Hex(state));
      expect(request?.redirectTo).toBe(REDIRECT_TO);
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("code_challenge")).toBe(
        await sha256Base64Url(request!.codeVerifier),
      );
    });
  });
}
