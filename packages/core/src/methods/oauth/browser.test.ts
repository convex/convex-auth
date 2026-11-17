// @vitest-environment jsdom
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import { createSignInWithApple } from "../apple/browser.ts";
import { createSignInWithDiscord } from "../discord/browser.ts";
import { createSignInWithGithub } from "../github/browser.ts";
import { createSignInWithGoogle } from "../google/browser.ts";
import { createOauthSignIn, createOauthState } from "./browser.ts";
import {
  acmeRefs,
  calledPath,
  completed,
  NAMESPACE,
  seedPendingFlow,
  setupOAuth,
} from "./testFlow.ts";

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function clientWithoutOauth() {
  return new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
}

describe("createOauthState", () => {
  test("reads and subscribes to the flow error", async () => {
    const { client, storage, mutation } = setupOAuth();
    const { flowError } = createOauthState(client);
    expect(flowError.get()).toBeNull();

    const listener = vi.fn();
    flowError.subscribe(listener);
    // The identity provider sends the user back with an error.
    seedPendingFlow(storage);
    window.history.replaceState(null, "", "/?convexAuthError=expired");
    await client.init();
    expect(mutation).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
    expect(flowError.get()).toEqual({ error: "EXPIRED" });
  });

  test("throws when oauth() is not registered", () => {
    expect(() => createOauthState(clientWithoutOauth())).toThrow(
      /No OAuth setup is registered/,
    );
  });
});

describe("createOauthSignIn", () => {
  test("finishes a saved flow and adopts the session", async () => {
    const { client, storage, mutation } = setupOAuth();
    seedPendingFlow(storage);
    mutation.mockResolvedValue(completed);
    const { signIn } = createOauthSignIn(client, acmeRefs);

    expect(await signIn({ code: "code-1" })).toEqual({ status: "complete" });
    expect(calledPath(mutation)).toBe("auth:completeSignInWithAcme");
    expect(client.getSnapshot().isAuthenticated).toBe(true);
  });

  test("throws when oauth() is not registered", () => {
    expect(() => createOauthSignIn(clientWithoutOauth(), acmeRefs)).toThrow(
      /No OAuth setup is registered/,
    );
  });
});

describe("createSignInWith<Provider>", () => {
  test("start the provider's own flow", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      href: "https://app.example.com/login",
      assign,
    });
    for (const [create, provider] of [
      [createSignInWithGoogle, "Google"],
      [createSignInWithGithub, "Github"],
      [createSignInWithApple, "Apple"],
      [createSignInWithDiscord, "Discord"],
    ] as const) {
      const { client, convexMutation } = setupOAuth();
      convexMutation.mockResolvedValue({
        redirect: "https://idp.example.com/authorize",
        state: "state-1",
      });
      const api = {
        [`startSignInWith${provider}`]: makeFunctionReference<"mutation">(
          `auth:startSignInWith${provider}`,
        ),
        [`completeSignInWith${provider}`]: makeFunctionReference<"mutation">(
          `auth:completeSignInWith${provider}`,
        ),
      };
      const { signIn } = create({ authClient: client, api: api as never });
      const result = await signIn();
      expect(result.status).toBe("redirect");
      expect(calledPath(convexMutation)).toBe(
        `auth:startSignInWith${provider}`,
      );
    }
  });
});
