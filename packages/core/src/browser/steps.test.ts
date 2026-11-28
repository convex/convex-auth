import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { STEP_REPORT_PREFIX } from "../lib/steps.ts";
import type { RefreshResult, TokenBundle } from "../lib/types.ts";
import { AuthClient } from "./sessionManager.ts";
import { InMemoryStorage } from "./storage.ts";
import { reportedSignInCall } from "../react/signInSteps.ts";
import { CLIENT_STEP_REPORTS_GLOBAL, resetClientOpsForTests } from "./steps.ts";

const NAMESPACE = "http://127.0.0.1:3210";
const NAMESPACE_SUFFIX = "http1270013210";
const JWT_KEY = "__convexAuthJWT";
const REFRESH_KEY = "__convexAuthRefreshToken";

// Secrets shaped like the real ones, so that a leak of any part shows.
const PASSWORD = "correct-horse-battery-staple";
const USERNAME = "alice-the-tester";
const ACCESS_1 =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSIsImV4cCI6MX0.c2lnbmF0dXJlLW9uZQ";
const ACCESS_2 =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSIsImV4cCI6Mn0.c2lnbmF0dXJlLXR3bw";
const REFRESH_1 = "rt1x9QwErTyUiOp|session-secret-one";
const REFRESH_2 = "rt2z8AsDfGhJkLm|session-secret-two";
const SECRETS = [PASSWORD, USERNAME, ACCESS_1, ACCESS_2, REFRESH_1, REFRESH_2];

const signInFn = makeFunctionReference<"mutation">(
  "auth:signInWithUsernamePassword",
);

function tokens(accessToken: string, refreshToken: string): TokenBundle {
  return { accessToken, refreshToken, refreshTokenExpiresAt: 0, userId: "u1" };
}

/** Every console call of the test, as text. */
let consoleLines: string[] = [];

function reports(): Array<Record<string, unknown>> {
  return consoleLines
    .filter((line) => line.startsWith(STEP_REPORT_PREFIX))
    .map((line) => JSON.parse(line.slice(STEP_REPORT_PREFIX.length)));
}

function steps(): string[] {
  return reports().map((report) => report.step as string);
}

/**
 * Sign in as the `usernamePassword` hook does, refresh as the Convex client
 * does when the token expires, and sign out.
 */
async function signInRefreshSignOut() {
  const refreshSession = vi.fn(async (): Promise<RefreshResult> => ({
    kind: "rotated",
    tokens: tokens(ACCESS_2, REFRESH_2),
  }));
  const signOut = vi.fn(async () => {});
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession, signOut },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  await client.init();
  const result = await reportedSignInCall(
    "module:react/index",
    "mutation",
    signInFn,
    async () => {
      void { username: USERNAME, password: PASSWORD };
      return { status: "complete", tokens: tokens(ACCESS_1, REFRESH_1) };
    },
  );
  await client.setSession(result.tokens);
  const marks = { signedIn: consoleLines.length };
  expect(await client.fetchAccessToken({ forceRefreshToken: false })).toBe(
    ACCESS_1,
  );
  expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
    ACCESS_2,
  );
  const refreshed = consoleLines.length;
  await client.signOut();
  expect(refreshSession).toHaveBeenCalledWith(REFRESH_1);
  expect(signOut).toHaveBeenCalledWith(REFRESH_2);
  return { ...marks, refreshed };
}

beforeEach(() => {
  resetClientOpsForTests();
  consoleLines = [];
  for (const level of ["log", "debug", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL];
  vi.restoreAllMocks();
});

describe("client step reports", () => {
  test("write nothing when the global is not set", async () => {
    await signInRefreshSignOut();
    expect(consoleLines).toEqual([]);
  });

  test("write nothing when the global is set to something other than true", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] =
      "true";
    await signInRefreshSignOut();
    expect(consoleLines).toEqual([]);
  });

  test("report a sign-in, a refresh, and a sign-out in order", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    const { signedIn, refreshed } = await signInRefreshSignOut();
    const all = steps();
    const bySlice = (from: number, to?: number) =>
      consoleLines
        .slice(from, to)
        .map(
          (line) =>
            JSON.parse(line.slice(STEP_REPORT_PREFIX.length)).step as string,
        );

    expect(bySlice(0, signedIn)).toEqual([
      // The load of the stored session.
      "crossTab.listen",
      "init",
      "state",
      "storage.read",
      "storage.read",
      "state",
      // The sign-in.
      "signIn.call",
      "signIn.return",
      "session.set",
      "storage.write",
      "storage.write",
      "state",
    ]);
    expect(bySlice(signedIn, refreshed)).toEqual([
      "token.fetch",
      "token.fetch",
      "lock.request",
      "lock.acquired",
      "refresh.start",
      "storage.read",
      "storage.write",
      "storage.write",
      "state",
      "refresh.end",
      "lock.released",
    ]);
    expect(bySlice(refreshed)).toEqual([
      "signOut.start",
      "storage.read",
      "signOut.revoke",
      "storage.remove",
      "storage.remove",
      "state",
      "signOut.end",
    ]);
    expect(all.length).toBe(consoleLines.length);

    const byStep = (step: string) => reports().filter((r) => r.step === step);
    expect(byStep("signIn.call")).toEqual([
      {
        v: 1,
        source: "convex-auth",
        step: "signIn.call",
        runsIn: "browser",
        part: "module:react/index",
        kind: "mutation",
        function: "auth:signInWithUsernamePassword",
        op: 2,
        opKind: "signIn",
      },
    ]);
    expect(byStep("signIn.return")[0]).toMatchObject({
      function: "auth:signInWithUsernamePassword",
      status: "complete",
    });
    expect(byStep("storage.write").map((r) => r.key)).toEqual([
      JWT_KEY,
      REFRESH_KEY,
      JWT_KEY,
      REFRESH_KEY,
    ]);
    expect(byStep("storage.read").map((r) => [r.key, r.found])).toEqual([
      [JWT_KEY, false],
      [REFRESH_KEY, false],
      [REFRESH_KEY, true],
      [REFRESH_KEY, true],
    ]);
    expect(byStep("state").map((r) => r.isAuthenticated)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(byStep("refresh.end")[0]).toMatchObject({
      part: "module:browser/sessionManager",
      outcome: "rotated",
      hasToken: true,
    });
    expect(byStep("lock.request")[0]).toMatchObject({
      part: "module:browser/mutex",
      lock: REFRESH_KEY,
      namespace: NAMESPACE_SUFFIX,
    });
    for (const report of byStep("storage.write")) {
      expect(report.namespace).toBe(NAMESPACE_SUFFIX);
    }
    for (const report of reports()) {
      expect(report).toMatchObject({ runsIn: "browser" });
      expect(report.part).toMatch(/^module:/);
    }
  });

  test("hold no password, username, or token", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    await signInRefreshSignOut();
    expect(consoleLines.length).toBeGreaterThan(20);
    const text = consoleLines.join("\n");
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
    }
    // No part of a token: its JWT header, or the secret half of a refresh token.
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("session-secret");
    // A tokens label is a small counter or "none", never a token or a hash.
    const labels = reports()
      .filter((r) => "tokens" in r)
      .map((r) => r.tokens);
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) {
      expect(
        label === "none" ||
          (Number.isInteger(label) &&
            (label as number) > 0 &&
            (label as number) < 100),
      ).toBe(true);
    }
  });

  test("report a sign-in call that throws, and pass the error on", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    const error = new Error(`bad password ${PASSWORD}`);
    await expect(
      reportedSignInCall("module:react/index", "action", signInFn, () =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);
    expect(steps()).toEqual(["signIn.call", "signIn.throw"]);
    expect(consoleLines.join("\n")).not.toContain(PASSWORD);
  });

  test("report a storage change from another tab", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    const window = Object.getOwnPropertyDescriptor(globalThis, "window");
    const listeners: Array<(event: StorageEvent) => void> = [];
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.push(l),
      removeEventListener: () => {},
    };
    try {
      const storage = new InMemoryStorage();
      const client = new AuthClient({
        mode: "spa",
        authApi: {
          refreshSession: async () => ({ kind: "noSession" }),
          signOut: async () => {},
        },
        storage,
        storageNamespace: NAMESPACE,
      });
      await client.init();
      consoleLines = [];
      for (const listener of listeners) {
        listener({
          key: `${JWT_KEY}_${NAMESPACE_SUFFIX}`,
          newValue: ACCESS_1,
          storageArea: storage,
        } as unknown as StorageEvent);
      }
      client.dispose();
    } finally {
      if (window === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        Object.defineProperty(globalThis, "window", window);
      }
    }
    expect(reports().map((r) => [r.step, r.key, r.cleared])).toEqual([
      ["crossTab.change", JWT_KEY, false],
      ["state", undefined, undefined],
      ["dispose", undefined, undefined],
    ]);
    expect(consoleLines.join("\n")).not.toContain(ACCESS_1);
  });
});

describe("sign-in reports", () => {
  test("return the call's own promise when the reports are off", () => {
    const promise = Promise.resolve({ status: "complete" });
    expect(
      reportedSignInCall(
        "module:react/index",
        "mutation",
        signInFn,
        () => promise,
      ),
    ).toBe(promise);
  });

  test("report a value the library does not return as other", async () => {
    (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
    const shaped = "alice_the_tester";
    await reportedSignInCall(
      "module:react/index",
      "mutation",
      signInFn,
      async () => ({
        status: shaped,
        kind: shaped,
        userError: { error: shaped },
      }),
    );
    await reportedSignInCall(
      "module:react/index",
      "mutation",
      signInFn,
      async () => ({
        status: "error",
        kind: "resend",
        userError: { error: "USERNAME_TAKEN" },
      }),
    );
    const returns = reports().filter((r) => r.step === "signIn.return");
    expect(
      returns.map(({ status, kind, error }) => ({ status, kind, error })),
    ).toEqual([
      { status: "other", kind: "other", error: "other" },
      { status: "error", kind: "resend", error: "USERNAME_TAKEN" },
    ]);
    expect(consoleLines.join("\n")).not.toContain(shaped);
  });
});
