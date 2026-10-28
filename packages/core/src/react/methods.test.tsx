// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import type { SignInValues } from "../browser/keyedStore.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import { AuthProvider } from "./client.tsx";
import { useAmbientSignInValue } from "./methods.ts";
import { stubSignInApi, unusedConvex } from "./testSignInApi.ts";

const NAMESPACE = "https://happy-animal-123.convex.cloud";

function makeClient() {
  return new AuthClient({
    mode: "spa",
    convex: unusedConvex,
    url: NAMESPACE,
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
}

/**
 * An {@link AuthClient} with a probe ambient sign-in registered, plus the
 * scoped values view its setup received so tests can write through it.
 */
function makeProbeClient() {
  const probe: { values?: SignInValues } = {};
  const client = new AuthClient({
    mode: "spa",
    convex: unusedConvex,
    url: NAMESPACE,
    signInApi: stubSignInApi().signInApi,
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
    ambientSignIns: [
      {
        id: "probe",
        setup: (ctx) => {
          probe.values = ctx.values;
        },
      },
    ],
  });
  if (probe.values === undefined) {
    throw new Error("probe setup did not run");
  }
  return { client, probeValues: probe.values };
}

function wrapperFor(client: AuthClient) {
  return ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client}>{children}</AuthProvider>
  );
}

describe("useAmbientSignInValue", () => {
  test("throws when used outside a provider", () => {
    expect(() =>
      renderHook(() => useAmbientSignInValue("probe", "greeting")),
    ).toThrow(
      /useAmbientSignInValue must be used within a <ConvexAuthProvider>/,
    );
  });

  test("returns undefined for an unregistered key", () => {
    const client = makeClient();
    const { result } = renderHook(
      () => useAmbientSignInValue("probe", "missing"),
      {
        wrapper: wrapperFor(client),
      },
    );
    expect(result.current).toBeUndefined();
  });

  test("reads a value seeded before render and re-renders on set", () => {
    const { client, probeValues } = makeProbeClient();
    probeValues.set("greeting", "hello");

    const { result } = renderHook(
      () => useAmbientSignInValue<string>("probe", "greeting"),
      { wrapper: wrapperFor(client) },
    );
    expect(result.current).toBe("hello");

    act(() => {
      probeValues.set("greeting", "hi again");
    });
    expect(result.current).toBe("hi again");
  });
});
