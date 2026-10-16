// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { anyApi, makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import { useAuthToken } from "../../react/index.tsx";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import { useSignInWithGithub } from "../github/react.ts";
import { useSignInWithGoogle } from "../google/react.ts";
import {
  useOauth,
  useOauthSignIn,
  type OauthCompleteResult,
  type OauthProviderApi,
  type OauthProviderRefs,
  type OauthStartResult,
  type SignInOptions,
  type UseOauthSignInReturn,
} from "./react.ts";
import {
  acmeRefs,
  NAMESPACE,
  calledPath,
  completed,
  oauthClient,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  stubReactNative,
} from "./testFlow.ts";

// Function references with the paths a generated `api.auth` would have. Nothing
// resolves them. The sign-in api is a mock, so these are addresses the
// assertions compare.
const googleStart = makeFunctionReference<"mutation">(
  "auth:startSignInWithGoogle",
) as OauthProviderApi["startSignIn"];
const googleComplete = makeFunctionReference<"mutation">(
  "auth:completeSignInWithGoogle",
) as OauthProviderApi["completeSignIn"];

/** The part of a generated `api.auth` the Google hook reads. */
const googleApi = {
  startSignInWithGoogle: googleStart,
  completeSignInWithGoogle: googleComplete,
};

/** The part of a generated `api.auth` the GitHub hook reads. */
const githubApi = {
  startSignInWithGithub: makeFunctionReference<"mutation">(
    "auth:startSignInWithGithub",
  ) as OauthProviderApi["startSignIn"],
  completeSignInWithGithub: makeFunctionReference<"mutation">(
    "auth:completeSignInWithGithub",
  ) as OauthProviderApi["completeSignIn"],
};

/** What the Google hook builds from {@link googleApi}, for seeding a flow. */
const googleRefs: OauthProviderRefs = {
  providerName: "google",
  startSignIn: googleStart,
  completeSignIn: googleComplete,
};

/** Auth state plus the Google sign-in, which most tests here read. */
function useGoogleFlow(api = googleApi) {
  return {
    auth: useAuth(),
    token: useAuthToken(),
    oauth: useSignInWithGoogle(api),
    flowError: useOauth().flowError,
  };
}

/** Render `hook` in the tree the way `ConvexAuthProvider` sets it up. */
function renderOAuth<T>(
  hook: () => T,
  {
    storage = new InMemoryStorage(),
    strictMode = false,
    onMutation,
  }: {
    storage?: InMemoryStorage;
    strictMode?: boolean;
    /** Configure the mutation mock before render (mount effects call it). */
    onMutation?: (mutation: ReturnType<typeof vi.fn>) => void;
  } = {},
) {
  const { client, signInApi, mutation, convexMutation } = oauthClient(storage);
  onMutation?.(mutation);
  const tree = (children: ReactNode) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  const wrapper = ({ children }: { children: ReactNode }) =>
    strictMode ? <StrictMode>{tree(children)}</StrictMode> : tree(children);
  const rendered = renderHook(hook, { wrapper });
  return { ...rendered, client, mutation, convexMutation, storage };
}

describe("OAuth React client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("the hooks throw when oauth() is not registered", () => {
    const client = new AuthClient({
      mode: "spa",
      authApi: {
        refreshSession: async () => ({ kind: "noSession" as const }),
        signOut: async () => {},
      },
      storage: new InMemoryStorage(),
      storageNamespace: NAMESPACE,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        {children}
      </AuthProvider>
    );
    expect(() =>
      renderHook(() => useSignInWithGoogle(googleApi), { wrapper }),
    ).toThrow(/No OAuth setup is registered/);
    expect(() => renderHook(() => useOauth(), { wrapper })).toThrow(
      /No OAuth setup is registered/,
    );
  });

  test("StrictMode double-mount redeems a callback code once", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, googleRefs);

    const { result, mutation } = renderOAuth(useGoogleFlow, {
      storage,
      strictMode: true,
      onMutation: (mutation) => mutation.mockResolvedValueOnce(completed),
    });

    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(mutation).toHaveBeenCalledOnce();
    // Completion rebuilt the reference from the persisted function path.
    expect(calledPath(mutation)).toBe("auth:completeSignInWithGoogle");
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(result.current.token).toBe("access-1");
    expect(result.current.flowError).toBeNull();
    expect(window.location.search).toBe("");
  });

  test("a callback error param reaches useOauth's flowError", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");

    const { result, mutation } = renderOAuth(useGoogleFlow);

    await waitFor(() =>
      expect(result.current.flowError?.error).toBe("ACCESS_DENIED"),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  test("signIn from the hook starts a flow with the picked references", async () => {
    stubReactNative();
    const { result, convexMutation, storage } = renderOAuth(useGoogleFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    convexMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await act(async () => {
      return await result.current.oauth.signIn({
        redirectTo: "http://localhost/app",
      });
    });

    expect(convexMutation).toHaveBeenCalledExactlyOnceWith(googleStart, {
      redirectTo: "http://localhost/app",
    });
    expectTypeOf(outcome).toEqualTypeOf<OauthStartResult>();
    expect(outcome).toEqual({
      status: "redirect",
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The persisted flow carries the completeSignIn function path, so
    // completion can run on a page that never mounted the hook.
    expect(readFlow(storage)).toEqual({
      providerName: "google",
      state: "state-1",
      completeSignIn: "auth:completeSignInWithGoogle",
    });
  });

  test("signIn with a code from the hook resolves to the completion result", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, googleRefs);
    const { result, mutation } = renderOAuth(useGoogleFlow, { storage });
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    mutation.mockResolvedValueOnce(completed);

    const outcome = await act(async () => {
      return await result.current.oauth.signIn({ code: "code-1" });
    });

    expectTypeOf(outcome).toEqualTypeOf<OauthCompleteResult>();
    expect(outcome).toEqual({ status: "complete" });
    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
  });

  test("useSignInWithGithub starts a flow with the GitHub references", async () => {
    stubReactNative();
    const { result, convexMutation, storage } = renderOAuth(() => ({
      auth: useAuth(),
      oauth: useSignInWithGithub(githubApi),
    }));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    convexMutation.mockResolvedValueOnce({
      redirect: "https://github.example/auth",
      state: "state-2",
    });

    await act(async () => {
      await result.current.oauth.signIn({
        redirectTo: "http://localhost/app",
      });
    });

    expect(convexMutation).toHaveBeenCalledExactlyOnceWith(
      githubApi.startSignInWithGithub,
      { redirectTo: "http://localhost/app" },
    );
    expect(readFlow(storage)).toEqual({
      providerName: "github",
      state: "state-2",
      completeSignIn: "auth:completeSignInWithGithub",
    });
  });

  test("useOauthSignIn runs an OAuth method that ships no hook of its own", async () => {
    stubReactNative();
    const { result, convexMutation, storage } = renderOAuth(() => ({
      auth: useAuth(),
      oauth: useOauthSignIn(acmeRefs),
    }));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    convexMutation.mockResolvedValueOnce({
      redirect: "https://acme.example/auth",
      state: "state-3",
    });

    const outcome = await act(async () => {
      return await result.current.oauth.signIn({
        redirectTo: "http://localhost/app",
      });
    });

    expect(convexMutation).toHaveBeenCalledExactlyOnceWith(
      acmeRefs.startSignIn,
      {
        redirectTo: "http://localhost/app",
      },
    );
    expect(outcome).toEqual({
      status: "redirect",
      redirect: new URL("https://acme.example/auth"),
    });
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-3",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("useSignInWithGoogle keeps a stable identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is, and it returns a new reference
    // object on every property access. The hook's memo has to key on the
    // function paths for the identity below to hold.
    const { result, rerender } = renderOAuth(() =>
      useGoogleFlow(anyApi.auth as unknown as typeof googleApi),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.oauth.signIn;

    rerender();

    expect(result.current.oauth.signIn).toBe(first);
  });

  test("the hook params accept the api module structurally", () => {
    type GoogleParam = Parameters<typeof useSignInWithGoogle>[0];
    const apiModule = {
      ...googleApi,
      signOut: undefined as unknown,
      startSignInWithGithub: undefined as unknown,
    };
    const full: GoogleParam = apiModule;
    void full;
    // @ts-expect-error - missing completeSignInWithGoogle must not typecheck.
    const missing: GoogleParam = { startSignInWithGoogle: googleStart };
    void missing;
  });

  test("signIn is typed by the shape it is called with", () => {
    type SignIn = UseOauthSignInReturn["signIn"];
    // Starting is declared last, so `ReturnType` gives its result.
    expectTypeOf<ReturnType<SignIn>>().toEqualTypeOf<
      Promise<OauthStartResult>
    >();
    // Never called. The typechecker checks the calls inside.
    const calls = (signIn: SignIn, options: SignInOptions) => {
      expectTypeOf(signIn()).toEqualTypeOf<Promise<OauthStartResult>>();
      expectTypeOf(signIn({ code: "code-1" })).toEqualTypeOf<
        Promise<OauthCompleteResult>
      >();
      // @ts-expect-error - options that might hold a code match neither shape.
      void signIn(options);
    };
    void calls;
  });
});
