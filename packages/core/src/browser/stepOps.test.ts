import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { STEP_REPORT_PREFIX } from "../lib/stepFormat.ts";
import type { RefreshResult, TokenBundle } from "../lib/types.ts";
import { reportedSignInCall } from "../react/signInSteps.ts";
import { AuthClient } from "./sessionManager.ts";
import {
  CLIENT_STEP_REPORTS_GLOBAL,
  reportClientStep,
  resetClientOpsForTests,
  startClientOp,
  withClientOp,
} from "./steps.ts";
import { InMemoryStorage } from "./storage.ts";

const NAMESPACE = "http://127.0.0.1:3210";
const JWT_KEY = "__convexAuthJWT";
const REFRESH_KEY = "__convexAuthRefreshToken";

const signInFn = makeFunctionReference<"mutation">(
  "auth:signInWithUsernamePassword",
);

type Report = Record<string, unknown>;

let consoleLines: string[] = [];

function reports(): Report[] {
  return consoleLines
    .filter((line) => line.startsWith(STEP_REPORT_PREFIX))
    .map((line) => JSON.parse(line.slice(STEP_REPORT_PREFIX.length)));
}

/** Each report as `[step, op, opKind, parentOp]`, with storage steps keyed. */
function chain(): Array<[string, unknown, unknown, unknown]> {
  return reports().map((r) => [
    r.key === undefined ? (r.step as string) : `${r.step as string} ${r.key}`,
    r.op,
    r.opKind,
    r.parentOp,
  ]);
}

function tokens(accessToken: string, refreshToken: string): TokenBundle {
  return { accessToken, refreshToken, refreshTokenExpiresAt: 0, userId: "u1" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function newClient(refreshSession: () => Promise<RefreshResult>) {
  return new AuthClient({
    mode: "spa",
    authApi: { refreshSession, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
}

function signInCall(result: () => Promise<unknown>) {
  return reportedSignInCall(
    "module:react/index",
    "mutation",
    signInFn,
    result,
  ) as Promise<{ status: string; tokens: TokenBundle }>;
}

function enable() {
  (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL] = true;
}

beforeEach(() => {
  resetClientOpsForTests();
  consoleLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CLIENT_STEP_REPORTS_GLOBAL];
  vi.restoreAllMocks();
});

describe("operations of client steps", () => {
  test("group a start-up, a sign-in with its session, a refresh, and a sign-out", async () => {
    enable();
    const client = newClient(async () => ({
      kind: "rotated",
      tokens: tokens("a2", "r2"),
    }));
    await client.init();
    const result = await signInCall(async () => ({
      status: "complete",
      tokens: tokens("a1", "r1"),
    }));
    await client.setSession(result.tokens);
    await client.fetchAccessToken({ forceRefreshToken: true });
    await client.signOut();

    expect(chain()).toEqual([
      ["crossTab.listen", 1, "init", undefined],
      ["init", 1, "init", undefined],
      ["state", 1, "init", undefined],
      [`storage.read ${JWT_KEY}`, 1, "init", undefined],
      [`storage.read ${REFRESH_KEY}`, 1, "init", undefined],
      ["state", 1, "init", undefined],
      ["signIn.call", 2, "signIn", undefined],
      ["signIn.return", 2, "signIn", undefined],
      ["session.set", 2, "signIn", undefined],
      [`storage.write ${JWT_KEY}`, 2, "signIn", undefined],
      [`storage.write ${REFRESH_KEY}`, 2, "signIn", undefined],
      ["state", 2, "signIn", undefined],
      ["token.fetch", 3, "tokenFetch", undefined],
      ["lock.request", 3, "tokenFetch", undefined],
      ["lock.acquired", 3, "tokenFetch", undefined],
      ["refresh.start", 3, "tokenFetch", undefined],
      [`storage.read ${REFRESH_KEY}`, 3, "tokenFetch", undefined],
      [`storage.write ${JWT_KEY}`, 3, "tokenFetch", undefined],
      [`storage.write ${REFRESH_KEY}`, 3, "tokenFetch", undefined],
      ["state", 3, "tokenFetch", undefined],
      ["refresh.end", 3, "tokenFetch", undefined],
      ["lock.released", 3, "tokenFetch", undefined],
      ["signOut.start", 4, "signOut", undefined],
      [`storage.read ${REFRESH_KEY}`, 4, "signOut", undefined],
      ["signOut.revoke", 4, "signOut", undefined],
      [`storage.remove ${JWT_KEY}`, 4, "signOut", undefined],
      [`storage.remove ${REFRESH_KEY}`, 4, "signOut", undefined],
      ["state", 4, "signOut", undefined],
      ["signOut.end", 4, "signOut", undefined],
    ]);
  });

  test("keep a refresh and a sign-in apart when they interleave", async () => {
    enable();
    const refreshed = deferred<RefreshResult>();
    const client = newClient(() => refreshed.promise);
    await client.init();
    await client.setSession(tokens("a0", "r0"));
    consoleLines = [];

    // The refresh starts and waits on the server.
    const fetching = client.fetchAccessToken({ forceRefreshToken: true });
    await vi.waitFor(() =>
      expect(chain().map(([step]) => step)).toContain(
        `storage.read ${REFRESH_KEY}`,
      ),
    );
    // A sign-in runs to the end while the refresh waits.
    const signedIn = deferred<unknown>();
    const call = signInCall(() => signedIn.promise);
    signedIn.resolve({ status: "complete", tokens: tokens("a1", "r1") });
    const result = await call;
    const setting = client.setSession(result.tokens);
    // The refresh answers in the middle of the sign-in's writes.
    refreshed.resolve({ kind: "rotated", tokens: tokens("a2", "r2") });
    await Promise.all([setting, fetching]);

    const refreshOp = reports()[0].op;
    const signInOp = reports().find((r) => r.step === "signIn.call")!.op;
    expect(refreshOp).not.toBe(signInOp);
    for (const [step, op] of chain()) {
      const expected =
        step.startsWith("signIn.") || step === "session.set"
          ? signInOp
          : step.startsWith("lock.") ||
              step.startsWith("refresh.") ||
              step === "token.fetch"
            ? refreshOp
            : undefined;
      if (expected !== undefined) expect([step, op]).toEqual([step, expected]);
    }
    // Each operation wrote both keys and reported its own state change.
    for (const op of [refreshOp, signInOp]) {
      expect(
        chain()
          .filter(([step, o]) => o === op && step.startsWith("storage.write"))
          .map(([step]) => step),
      ).toEqual([`storage.write ${JWT_KEY}`, `storage.write ${REFRESH_KEY}`]);
      expect(
        chain().filter(([step, o]) => o === op && step === "state"),
      ).toHaveLength(1);
    }
    // No step is left without its operation.
    expect(chain().every(([, op]) => op !== undefined)).toBe(true);
  });

  test("link each session to its own sign-in when two return out of order", async () => {
    enable();
    const client = newClient(async () => ({ kind: "noSession" }));
    await client.init();
    consoleLines = [];
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const callA = signInCall(() => first.promise);
    const callB = signInCall(() => second.promise);
    second.resolve({ status: "complete", tokens: tokens("b", "rb") });
    const resultB = await callB;
    first.resolve({ status: "complete", tokens: tokens("a", "ra") });
    const resultA = await callA;
    await Promise.all([
      client.setSession(resultB.tokens),
      client.setSession(resultA.tokens),
    ]);

    const calls = reports().filter((r) => r.step === "signIn.call");
    const [opA, opB] = calls.map((r) => r.op);
    expect(opA).not.toBe(opB);
    const sets = reports().filter((r) => r.step === "session.set");
    expect(sets.map((r) => r.op)).toEqual([opB, opA]);
    for (const op of [opA, opB]) {
      expect(
        chain()
          .filter(([step, o]) => o === op && step !== "state")
          .map(([step]) => step),
      ).toEqual([
        "signIn.call",
        "signIn.return",
        "session.set",
        `storage.write ${JWT_KEY}`,
        `storage.write ${REFRESH_KEY}`,
      ]);
    }
    // Only the first notification after both writes sees a change, and it
    // runs in the sign-in that resumed first.
    expect(chain().filter(([step]) => step === "state")).toEqual([
      ["state", opB, "signIn", undefined],
    ]);
  });

  test("give a session the library did not see returned an operation of its own", async () => {
    enable();
    const client = newClient(async () => ({ kind: "noSession" }));
    await client.init();
    const result = await signInCall(async () => ({
      status: "complete",
      tokens: tokens("a", "r"),
    }));
    consoleLines = [];
    // A copy is another object, so nothing says it came from the sign-in.
    await client.setSession({ ...result.tokens });
    expect(chain()).toEqual([
      ["session.set", 3, "setSession", undefined],
      [`storage.write ${JWT_KEY}`, 3, "setSession", undefined],
      [`storage.write ${REFRESH_KEY}`, 3, "setSession", undefined],
      ["state", 3, "setSession", undefined],
    ]);
  });

  test("name a pending sign-in as the parent only of what starts in its synchronous call", async () => {
    enable();
    const client = newClient(async () => ({ kind: "noSession" }));
    await client.init();
    consoleLines = [];
    const outside = deferred<void>();
    await client.withSignInPending(async () => {
      // Started in the synchronous call of the pending sign-in.
      const call = signInCall(async () => ({
        status: "complete",
        tokens: tokens("a", "r"),
      }));
      await call;
      // Started after an await: other code may have run, so no parent.
      await signInCall(async () => ({ status: "pending" }));
      outside.resolve();
    });
    await outside.promise;

    const pending = reports()[0];
    expect(pending).toMatchObject({
      step: "signIn.pending.start",
      opKind: "signInPending",
    });
    const calls = reports().filter((r) => r.step === "signIn.call");
    expect(calls[0]).toMatchObject({ opKind: "signIn", parentOp: pending.op });
    expect(calls[1].opKind).toBe("signIn");
    expect(calls[1].parentOp).toBeUndefined();
    const end = reports().find((r) => r.step === "signIn.pending.end");
    expect(end?.op).toBe(pending.op);
  });

  test("leave a step with no operation when nothing hands it one", async () => {
    enable();
    const op = startClientOp("signOut");
    let later: Promise<void> = Promise.resolve();
    withClientOp(op, () => {
      reportClientStep("module:react/client", "inside");
      later = (async () => {
        await null;
        reportClientStep("module:react/client", "afterAwait");
      })();
    });
    reportClientStep("module:react/client", "outside");
    await later;
    expect(chain()).toEqual([
      ["inside", 1, "signOut", undefined],
      ["outside", undefined, undefined, undefined],
      ["afterAwait", undefined, undefined, undefined],
    ]);
  });

  test("name the start-up as the parent of what an ambient sign-in starts in its onInit", async () => {
    enable();
    let clientRef: AuthClient | undefined;
    const client = new AuthClient({
      mode: "spa",
      authApi: {
        refreshSession: async () => ({ kind: "noSession" }),
        signOut: async () => {},
      },
      storage: new InMemoryStorage(),
      storageNamespace: NAMESPACE,
      ambientSignIns: {
        signIns: [
          {
            id: "test",
            setup: ({ client, storage }) => {
              clientRef = client;
              return {
                onInit: () => {
                  void storage.get("flow");
                  void client.withSignInPending(async () => {});
                },
              };
            },
          },
        ],
        signInApi: {
          mutation: () => Promise.reject(new Error("unused")),
          action: () => Promise.reject(new Error("unused")),
        },
        convex: { mutation: () => Promise.reject(new Error("unused")) },
      },
    });
    await client.init();
    expect(clientRef).toBe(client);
    const rows = chain();
    // The pending sign-in changes no state: the client is loading already.
    expect(rows).toEqual([
      ["crossTab.listen", 1, "init", undefined],
      ["init", 1, "init", undefined],
      ["state", 1, "init", undefined],
      ["ambientSignIn.init", 1, "init", undefined],
      ["storage.read __convexAuthProvider_test_flow", 1, "init", undefined],
      ["signIn.pending.start", 2, "signInPending", 1],
      [`storage.read ${JWT_KEY}`, 1, "init", undefined],
      [`storage.read ${REFRESH_KEY}`, 1, "init", undefined],
      ["signIn.pending.end", 2, "signInPending", 1],
      ["state", 1, "init", undefined],
    ]);
  });
});

describe("the initial state", () => {
  test("report the state the client starts from once, under the start-up", async () => {
    enable();
    const client = newClient(async () => ({ kind: "noSession" }));
    await client.init();
    client.dispose();
    await client.init();
    const states = reports().filter((r) => r.step === "state");
    expect(states[0]).toEqual({
      v: 1,
      source: "convex-auth",
      step: "state",
      runsIn: "browser",
      part: "module:browser/sessionManager",
      isLoading: true,
      isAuthenticated: false,
      tokenChanged: false,
      initial: true,
      op: 1,
      opKind: "init",
    });
    // Only the first start-up reports it; the change after the load does not.
    expect(states.filter((r) => r.initial === true)).toHaveLength(1);
    expect(states[1]).toMatchObject({ isLoading: false, op: 1 });
    expect(states[1].initial).toBeUndefined();
  });
});

describe("operations when the reports are off", () => {
  test("start no operation and run the function itself", async () => {
    expect(startClientOp("signIn")).toBeNull();
    const promise = Promise.resolve(1);
    expect(withClientOp(null, () => promise)).toBe(promise);
    enable();
    // The counter did not move while the reports were off.
    expect(startClientOp("signIn")?.op).toBe(1);
  });

  test("leave the client's results and storage as they are with the reports on", async () => {
    const run = async () => {
      const storage = new InMemoryStorage();
      const client = new AuthClient({
        mode: "spa",
        authApi: {
          refreshSession: async () => ({
            kind: "rotated",
            tokens: tokens("a2", "r2"),
          }),
          signOut: async () => {},
        },
        storage,
        storageNamespace: NAMESPACE,
      });
      const snapshots: unknown[] = [];
      client.subscribe(() => snapshots.push(client.getSnapshot()));
      await client.init();
      const result = await signInCall(async () => ({
        status: "complete",
        tokens: tokens("a1", "r1"),
      }));
      await client.withSignInPending(() => client.setSession(result.tokens));
      const token = await client.fetchAccessToken({ forceRefreshToken: true });
      const stored = JSON.stringify(storage);
      await client.signOut();
      return { snapshots, token, stored, after: JSON.stringify(storage) };
    };
    const off = await run();
    expect(consoleLines).toEqual([]);
    enable();
    const on = await run();
    expect(consoleLines.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });
});
