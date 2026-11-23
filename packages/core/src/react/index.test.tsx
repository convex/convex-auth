// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { StrictMode } from "react";
import { describe, expect, test, vi } from "vitest";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";
import { useOauth } from "../methods/oauth/react.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import { useAuthClient, useAuthSignInApi } from "./client.tsx";
import {
  ConvexAuthProvider,
  type ConvexAuthProviderProps,
  createAuthClient,
  useAuthToken,
} from "./index.tsx";
import { useAmbientSignInValue } from "./methods.ts";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
  isAuthenticated: makeFunctionReference<"query">("auth:isAuthenticated"),
};

/**
 * A real Convex client against a fake deployment URL. Nothing here
 * authenticates or subscribes, so it never opens a connection.
 */
function makeConvexClient() {
  return new ConvexReactClient("https://happy-animal-123.convex.cloud");
}

/** Renders the value a probe setup publishes under its scoped `status` key. */
function ProbeStatus() {
  const status = useAmbientSignInValue<string>("probe", "status");
  return <div>{status ?? "missing"}</div>;
}

/**
 * Renders the flow error from the default oauth setup. The hook throws when
 * oauth() was never registered, so rendering this at all is the assertion.
 */
function OauthFlowError() {
  return <div>{String(useOauth().flowError)}</div>;
}

describe("ConvexAuthProvider ambient sign-ins", () => {
  test("published setup values are readable on the first render", () => {
    const client = makeConvexClient();
    const probe: AmbientSignInClient = {
      id: "probe",
      setup: (ctx) => {
        ctx.values.set("status", "registered");
      },
    };
    render(
      <ConvexAuthProvider client={client} api={API} ambientSignIns={[probe]}>
        <ProbeStatus />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("registered")).toBeDefined();
  });

  test("onInit runs once per client under StrictMode", () => {
    const client = makeConvexClient();
    const onInit = vi.fn();
    render(
      <StrictMode>
        <ConvexAuthProvider
          client={client}
          api={API}
          ambientSignIns={[{ id: "probe", setup: () => ({ onInit }) }]}
        >
          <div />
        </ConvexAuthProvider>
      </StrictMode>,
    );
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  test("setups and hooks receive the same sign-in api", () => {
    const client = makeConvexClient();
    const fromSetup: AuthSignInApi[] = [];
    const fromHook: AuthSignInApi[] = [];
    function Capture() {
      fromHook.push(useAuthSignInApi());
      return null;
    }
    render(
      <ConvexAuthProvider
        client={client}
        api={API}
        ambientSignIns={[
          {
            id: "probe",
            setup: (ctx) => {
              fromSetup.push(ctx.signInApi);
            },
          },
        ]}
      >
        <Capture />
      </ConvexAuthProvider>,
    );
    expect(fromHook[0]).toBe(fromSetup[0]);
  });

  test("the sign-in api routes through the Convex client", async () => {
    const client = makeConvexClient();
    const mutationSpy = vi
      .spyOn(client, "mutation")
      .mockResolvedValue("result" as never);
    const signIn = makeFunctionReference<"mutation">("auth:signInProbe");
    const captured: AuthSignInApi[] = [];
    function Capture() {
      captured.push(useAuthSignInApi());
      return null;
    }
    render(
      <ConvexAuthProvider client={client} api={API}>
        <Capture />
      </ConvexAuthProvider>,
    );
    await expect(captured[0].mutation(signIn, {})).resolves.toBe("result");
    expect(mutationSpy).toHaveBeenCalledWith(signIn, {});
  });

  test("oauth() is registered when no ambient sign-ins are given", () => {
    const client = makeConvexClient();
    render(
      <ConvexAuthProvider client={client} api={API}>
        <OauthFlowError />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("null")).toBeDefined();
  });
});

describe("ConvexAuthProvider with an auth client", () => {
  function makeAuthClient() {
    return createAuthClient({
      convex: makeConvexClient(),
      api: API,
      storage: new InMemoryStorage(),
    });
  }

  function Token() {
    return <div>{useAuthToken() ?? "no token"}</div>;
  }

  test("hooks read the auth client passed as auth", () => {
    const auth = makeAuthClient();
    const fromHook: unknown[] = [];
    function Capture() {
      fromHook.push(useAuthClient(), useAuthSignInApi());
      return null;
    }
    render(
      <ConvexAuthProvider auth={auth}>
        <Capture />
      </ConvexAuthProvider>,
    );
    expect(fromHook[0]).toBe(auth);
    expect(fromHook[1]).toBe(auth.signIn);
  });

  test("initialToken is stored when the auth client starts", async () => {
    const auth = makeAuthClient();
    render(
      <ConvexAuthProvider auth={auth} initialToken="access-ssr">
        <Token />
      </ConvexAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("access-ssr")).toBeDefined());
    expect(auth.getAccessToken()).toBe("access-ssr");
  });

  test("the auth client survives a remount under StrictMode", async () => {
    const auth = makeAuthClient();
    const onInit = vi.spyOn(auth, "init");
    render(
      <StrictMode>
        <ConvexAuthProvider auth={auth} initialToken="access-ssr">
          <Token />
        </ConvexAuthProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText("access-ssr")).toBeDefined());
    expect(onInit).toHaveBeenCalledTimes(2);
  });

  test("passing auth and client together throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const props = {
      auth: makeAuthClient(),
      client: makeConvexClient(),
      api: API,
      children: <div />,
    } as unknown as ConvexAuthProviderProps;
    expect(() => render(<ConvexAuthProvider {...props} />)).toThrow(
      /either auth or client and api, not both/,
    );
  });

  test("an auth client without a Convex client throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const auth = makeAuthClient();
    Object.defineProperty(auth, "convex", { value: undefined });
    expect(() =>
      render(
        <ConvexAuthProvider auth={auth}>
          <div />
        </ConvexAuthProvider>,
      ),
    ).toThrow(/needs an auth client from createAuthClient/);
  });
});
