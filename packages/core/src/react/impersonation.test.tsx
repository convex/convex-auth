// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { makeFunctionReference } from "convex/server";
import { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { AuthClient } from "../browser/sessionManager.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import type {
  ImpersonateUserFn,
  StopImpersonatingFn,
  TokenBundle,
} from "../lib/types.ts";
import { AuthProvider } from "./client.tsx";
import { useImpersonation } from "./impersonation.tsx";
import { stubSignInApi } from "./testSignInApi.ts";

const api = {
  impersonateUser: makeFunctionReference<"mutation">(
    "auth:impersonateUser",
  ) as unknown as ImpersonateUserFn<"users">,
  stopImpersonating: makeFunctionReference<"mutation">(
    "auth:stopImpersonating",
  ) as unknown as StopImpersonatingFn,
};

/** An access token of the given session, readable like a real one. */
function accessTokenOf(sessionId: string): string {
  const payload = btoa(JSON.stringify({ sub: sessionId }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `header.${payload}.signature`;
}

function bundleOf(sessionId: string): TokenBundle {
  return {
    accessToken: accessTokenOf(sessionId),
    refreshToken: `refresh-${sessionId}`,
    refreshTokenExpiresAt: 0,
    userId: `user-of-${sessionId}`,
  };
}

/** A client signed in with the admin's session, and the hook rendered in it. */
async function renderImpersonation() {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: "https://happy-animal-123.convex.cloud",
  });
  await client.init();
  await client.setSession(bundleOf("admin-session"));
  const { signInApi, run } = stubSignInApi();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  const hook = renderHook(() => useImpersonation(api), { wrapper });
  return { client, run, hook };
}

describe("useImpersonation", () => {
  test("impersonateUser moves the client to the session of the target", async () => {
    const { client, run, hook } = await renderImpersonation();
    const complete = {
      status: "complete",
      tokens: bundleOf("impersonation-session"),
    };
    run.mockResolvedValue(complete);

    let result;
    await act(async () => {
      result = await hook.result.current.impersonateUser(
        "alice" as Parameters<typeof hook.result.current.impersonateUser>[0],
      );
    });

    expect(run).toHaveBeenCalledWith({ userId: "alice" });
    expect(result).toEqual(complete);
    expect(client.getSnapshot().sessionId).toBe("impersonation-session");
  });

  test("stopImpersonating moves the client back to the impersonator's session", async () => {
    const { client, run, hook } = await renderImpersonation();
    await client.setSession(bundleOf("impersonation-session"));
    run.mockResolvedValue({
      status: "complete",
      tokens: bundleOf("admin-session"),
    });

    await act(async () => {
      await hook.result.current.stopImpersonating();
    });

    expect(run).toHaveBeenCalledWith({});
    expect(client.getSnapshot().sessionId).toBe("admin-session");
  });

  test("an error of the backend adopts nothing", async () => {
    const { client, run, hook } = await renderImpersonation();
    const refused = {
      status: "error",
      userError: { error: "NOT_AUTHORIZED" },
    };
    run.mockResolvedValue(refused);

    let result;
    await act(async () => {
      result = await hook.result.current.impersonateUser(
        "alice" as Parameters<typeof hook.result.current.impersonateUser>[0],
      );
    });

    expect(result).toEqual(refused);
    expect(client.getSnapshot().sessionId).toBe("admin-session");
  });

  test("stopImpersonating clears the local session immediately on IMPERSONATOR_SESSION_ENDED", async () => {
    const { client, run, hook } = await renderImpersonation();
    await client.setSession(bundleOf("impersonation-session"));
    run.mockResolvedValue({
      status: "error",
      userError: { error: "IMPERSONATOR_SESSION_ENDED" },
    });

    let result;
    await act(async () => {
      result = await hook.result.current.stopImpersonating();
    });

    expect(result).toEqual({
      status: "error",
      userError: { error: "IMPERSONATOR_SESSION_ENDED" },
    });
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      sessionId: null,
    });
  });

  test("a call that throws resolves to OTHER_ERROR with the cause", async () => {
    const { client, run, hook } = await renderImpersonation();
    const cause = new Error("This session already has an impersonation.");
    run.mockRejectedValue(cause);

    let result;
    await act(async () => {
      result = await hook.result.current.stopImpersonating();
    });

    expect(result).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(client.getSnapshot().sessionId).toBe("admin-session");
  });

  test("a second call sends nothing when the first one moved the client", async () => {
    const { client, run, hook } = await renderImpersonation();
    await client.setSession(bundleOf("impersonation-session"));
    const { promise, resolve } = Promise.withResolvers<unknown>();
    run.mockReturnValue(promise);

    let first, second;
    await act(async () => {
      const firstCall = hook.result.current.stopImpersonating();
      const secondCall = hook.result.current.stopImpersonating();
      resolve({ status: "complete", tokens: bundleOf("admin-session") });
      [first, second] = await Promise.all([firstCall, secondCall]);
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: "complete" });
    expect(second).toEqual({
      status: "error",
      userError: { error: "SESSION_CHANGED" },
    });
    expect(client.getSnapshot().sessionId).toBe("admin-session");
  });

  test("a second call is sent when the first one moved nothing", async () => {
    const { client, run, hook } = await renderImpersonation();
    run
      .mockResolvedValueOnce({
        status: "error",
        userError: { error: "NOT_AUTHORIZED" },
      })
      .mockResolvedValueOnce({
        status: "complete",
        tokens: bundleOf("impersonation-session"),
      });
    type UserId = Parameters<typeof hook.result.current.impersonateUser>[0];

    let first, second;
    await act(async () => {
      [first, second] = await Promise.all([
        hook.result.current.impersonateUser("alice" as UserId),
        hook.result.current.impersonateUser("bob" as UserId),
      ]);
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ status: "error" });
    expect(second).toMatchObject({ status: "complete" });
    expect(client.getSnapshot().sessionId).toBe("impersonation-session");
  });

  test("pending is true while a call is under way", async () => {
    const { run, hook } = await renderImpersonation();
    const { promise, resolve } = Promise.withResolvers<unknown>();
    run.mockReturnValue(promise);
    expect(hook.result.current.pending).toBe(false);

    let call: Promise<unknown>;
    act(() => {
      call = hook.result.current.stopImpersonating();
    });
    expect(hook.result.current.pending).toBe(true);
    await act(async () => {
      resolve({ status: "error", userError: { error: "NOT_IMPERSONATING" } });
      await call;
    });

    expect(hook.result.current.pending).toBe(false);
  });

  test("throws when used outside a provider", () => {
    expect(() => renderHook(() => useImpersonation(api))).toThrow(
      "within a <ConvexAuthProvider>",
    );
  });

  test("under SSR, runs through switchSignInApi without deadlocking against the locked signInApi", async () => {
    const client = new AuthClient({
      mode: "ssr",
      authApi: {
        refreshSession: async () => null,
        signOut: async () => {},
      },
      storage: new InMemoryStorage(),
      storageNamespace: "https://happy-animal-123.convex.cloud",
    });
    await client.init();
    await client.setSession({
      accessToken: accessTokenOf("admin-session"),
      userId: "user-of-admin-session",
    });
    const raw = stubSignInApi();
    const lockedSignInApi = {
      mutation: (fn: never, args: never) =>
        client.runSsrSignIn(() => raw.signInApi.mutation(fn, args)),
      action: (fn: never, args: never) =>
        client.runSsrSignIn(() => raw.signInApi.action(fn, args)),
    };
    raw.run.mockResolvedValue({
      status: "complete",
      tokens: {
        accessToken: accessTokenOf("impersonation-session"),
        userId: "user-of-impersonation-session",
      },
    });
    const hook = renderHook(() => useImpersonation(api), {
      wrapper: ({ children }) => (
        <AuthProvider
          authClient={client}
          signInApi={lockedSignInApi}
          switchSignInApi={raw.signInApi}
        >
          {children}
        </AuthProvider>
      ),
    });
    type UserId = Parameters<typeof hook.result.current.impersonateUser>[0];

    let result;
    await act(async () => {
      result = await hook.result.current.impersonateUser("alice" as UserId);
    });

    expect(result).toMatchObject({ status: "complete" });
    expect(client.getSnapshot().sessionId).toBe("impersonation-session");
  });
});
