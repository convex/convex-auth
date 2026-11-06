// @vitest-environment node
//
// jsdom always has a `window.location`, so the client's no-page-URL cases need
// their own file with a node environment.
import { afterEach, describe, expect, test, vi } from "vitest";
import { acmeRefs, readFlow, setupOAuth } from "./testFlow.ts";

describe("OAuth client with no page URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("init does nothing when there is no window", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, mutation } = setupOAuth();

    await client.init();

    expect(logged).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("init does nothing when the window has no location", async () => {
    // The React Native shape. Reading `window.location.href` here would throw,
    // and the thrown error would be logged as a failed init callback.
    vi.stubGlobal("window", {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, mutation } = setupOAuth();

    await client.init();

    expect(logged).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("signIn without redirectTo says redirectTo is required", async () => {
    vi.stubGlobal("window", {});
    const { actions, convexMutation } = setupOAuth();

    await expect(actions.signIn(acmeRefs)).rejects.toThrow(
      /`redirectTo` is required/,
    );
    expect(convexMutation).not.toHaveBeenCalled();
  });

  test("a signIn that throws leaves the previous flow error alone", async () => {
    // Put an error in place through a callback, on a page that has a URL.
    vi.stubGlobal("window", {
      location: { href: "https://app.example/?convexAuthError=access_denied" },
      history: { state: null, replaceState: () => {} },
    });
    const { client, actions, flowError } = setupOAuth();
    await client.init();
    expect(flowError()?.error).toBe("ACCESS_DENIED");

    vi.stubGlobal("window", {});
    await expect(actions.signIn(acmeRefs)).rejects.toThrow();

    expect(flowError()?.error).toBe("ACCESS_DENIED");
  });

  test("signIn with redirectTo starts a flow without navigating", async () => {
    // Assigning `window.location.href` would throw here, so a flow that starts
    // must not try. React Native opens the returned url itself.
    vi.stubGlobal("window", {});
    const { actions, convexMutation, storage } = setupOAuth();
    convexMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });

    const outcome = await actions.signIn(acmeRefs, {
      redirectTo: "https://app.example/done",
    });

    expect(outcome).toEqual({
      status: "redirect",
      redirect: new URL("https://provider.example/auth"),
    });
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInWithAcme",
    });
  });
});
