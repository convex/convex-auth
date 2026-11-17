import { getFunctionName, anyApi, type FunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type { TokenBundle } from "../../lib/types.ts";
import type {
  WireAuthenticationResponse,
  WireRegistrationResponse,
} from "../../components/passkey/validation.ts";
import {
  createPasskeyAutofill,
  createPasskeyCeremonySlot,
} from "./autofill.ts";
import {
  createAddPasskey,
  createRemovePasskey,
  createSignInWithUsernamePasskey,
  type AddPasskeyApi,
  type RemovePasskeyApi,
  type ResolvedPasskeyCeremonies,
  type UsernamePasskeyApi,
  type WireCreationOptions,
  type WireRequestOptions,
} from "./browser.ts";

// The fakes below stand in for a platform: no browser, no
// `@simplewebauthn/browser`, only the `ResolvedPasskeyCeremonies` contract.

const requestOptions = { challenge: "challenge-1" } as WireRequestOptions;
const creationOptions = { challenge: "challenge-2" } as WireCreationOptions;
const authenticationResponse = {
  id: "cred-1",
} as unknown as WireAuthenticationResponse;
const registrationResponse = {
  id: "cred-2",
} as unknown as WireRegistrationResponse;

const bundle: TokenBundle = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const aborted = {
  success: false as const,
  userError: { error: "CEREMONY_ABORTED" as const },
};

/** A conditional request that stays pending until its signal aborts. */
function pendingUntilAborted(_options: unknown, signal: AbortSignal) {
  return new Promise<typeof aborted>((resolve) => {
    if (signal.aborted) {
      resolve(aborted);
      return;
    }
    signal.addEventListener("abort", () => resolve(aborted), { once: true });
  });
}

function fakeCeremonies(
  overrides: Partial<ResolvedPasskeyCeremonies> = {},
): ResolvedPasskeyCeremonies {
  return {
    isSupported: () => true,
    register: vi.fn(async () => ({
      success: true as const,
      response: registrationResponse,
    })),
    authenticate: vi.fn(async () => ({
      success: true as const,
      response: authenticationResponse,
    })),
    isAutofillAvailable: vi.fn(async () => true),
    authenticateWithAutofill: vi.fn(pendingUntilAborted),
    onResume: () => () => {},
    ...overrides,
  };
}

/** Let the pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createPasskeyAutofill", () => {
  test("hands the picked response to onAssertion and reports success", async () => {
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(async () => ({
        success: true as const,
        response: authenticationResponse,
      })),
    });
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const autofill = createPasskeyAutofill({ ceremonies, start, onAssertion });
    const statuses: string[] = [];
    autofill.state.subscribe(() => statuses.push(autofill.state.get().status));

    expect(autofill.state.get()).toEqual({
      available: null,
      status: "idle",
      lastError: null,
    });
    autofill.start();
    await flush();

    expect(autofill.state.get()).toEqual({
      available: true,
      status: "signedIn",
      lastError: null,
    });
    expect(onAssertion).toHaveBeenCalledWith(authenticationResponse);
    expect(statuses).toEqual(["idle", "waiting", "signingIn", "signedIn"]);
  });

  test("stops when the platform has no autofill", async () => {
    const ceremonies = fakeCeremonies({
      isAutofillAvailable: vi.fn(async () => false),
    });
    const start = vi.fn(async () => requestOptions);
    const autofill = createPasskeyAutofill({
      ceremonies,
      start,
      onAssertion: vi.fn(),
    });
    autofill.start();
    await flush();
    expect(autofill.state.get()).toMatchObject({
      available: false,
      status: "stopped",
    });
    expect(start).not.toHaveBeenCalled();
  });

  test("a pause aborts the request and parks the loop until the resume", async () => {
    const ceremonies = fakeCeremonies();
    const start = vi.fn(async () => requestOptions);
    const autofill = createPasskeyAutofill({
      ceremonies,
      start,
      onAssertion: vi.fn(),
    });
    const stop = autofill.start();
    await flush();
    expect(autofill.state.get().status).toBe("waiting");
    expect(start).toHaveBeenCalledTimes(1);

    // Two modal flows: the pauses are counted.
    autofill.pauseAutofillFlow();
    autofill.pauseAutofillFlow();
    await flush();
    autofill.resumeAutofillFlow();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    autofill.resumeAutofillFlow();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(autofill.state.get()).toMatchObject({
      status: "waiting",
      lastError: null,
    });

    stop();
  });

  test("a pause taken before the start holds the first request", async () => {
    const start = vi.fn(async () => requestOptions);
    const autofill = createPasskeyAutofill({
      ceremonies: fakeCeremonies(),
      start,
      onAssertion: vi.fn(),
    });
    autofill.pauseAutofillFlow();
    const stop = autofill.start();
    await flush();
    expect(start).not.toHaveBeenCalled();
    autofill.resumeAutofillFlow();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    stop();
  });

  test("a ceremony that takes the slot without pausing stops the flow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let endRequest!: () => void;
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(
        () =>
          new Promise<typeof aborted>((resolve) => {
            endRequest = () => resolve(aborted);
          }),
      ),
    });
    const start = vi.fn(async () => requestOptions);
    const autofill = createPasskeyAutofill({
      ceremonies,
      start,
      onAssertion: vi.fn(),
    });
    autofill.start();
    await flush();

    endRequest();
    await flush();
    expect(autofill.state.get()).toMatchObject({
      status: "stopped",
      lastError: { error: "CEREMONY_ABORTED" },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("stops after three failed assertions in a row", async () => {
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(async () => ({
        success: true as const,
        response: authenticationResponse,
      })),
    });
    const flowError = { error: "VERIFICATION_FAILED" as const };
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({
      success: false as const,
      userError: flowError,
    }));
    const autofill = createPasskeyAutofill({ ceremonies, start, onAssertion });
    autofill.start();
    await flush();
    expect(autofill.state.get()).toMatchObject({
      status: "stopped",
      lastError: flowError,
    });
    expect(start).toHaveBeenCalledTimes(3);
  });

  test("a thrown start mutation stops the flow with OTHER_ERROR", async () => {
    const cause = new Error("boom");
    const autofill = createPasskeyAutofill({
      ceremonies: fakeCeremonies(),
      start: async () => {
        throw cause;
      },
      onAssertion: vi.fn(),
    });
    autofill.start();
    await flush();
    expect(autofill.state.get()).toMatchObject({
      status: "stopped",
      lastError: { error: "OTHER_ERROR", cause },
    });
  });

  test("the stop aborts the request, and a new start runs a new loop", async () => {
    const ceremonies = fakeCeremonies();
    const start = vi.fn(async () => requestOptions);
    const autofill = createPasskeyAutofill({
      ceremonies,
      start,
      onAssertion: vi.fn(),
    });
    const stop = autofill.start();
    await flush();
    stop();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(ceremonies.authenticateWithAutofill).mock
      .calls[0][1];
    expect(signal.aborted).toBe(true);

    const stopAgain = autofill.start();
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(autofill.state.get().status).toBe("waiting");
    stopAgain();
  });

  test("a second start stops the first loop, whose stop then leaves the second alone", async () => {
    const ceremonies = fakeCeremonies();
    const start = vi.fn(async () => requestOptions);
    const autofill = createPasskeyAutofill({
      ceremonies,
      start,
      onAssertion: vi.fn(),
    });
    const stopFirst = autofill.start();
    await flush();
    const stopSecond = autofill.start();
    await flush();
    const signals = vi
      .mocked(ceremonies.authenticateWithAutofill)
      .mock.calls.map(([, signal]) => signal);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);

    // The first loop's stop comes late, e.g. from a component that unmounts
    // after another one started the flow. It must not end the second loop.
    stopFirst();
    await flush();
    expect(signals[1].aborted).toBe(false);
    expect(autofill.state.get().status).toBe("waiting");

    // A pause still reaches the request that runs.
    autofill.pauseAutofillFlow();
    expect(signals[1].aborted).toBe(true);
    stopSecond();
  });

  test("subscribers hear of signingIn once the modal flow is locked out", async () => {
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(async () => ({
        success: true as const,
        response: authenticationResponse,
      })),
    });
    const autofill = createPasskeyAutofill({
      ceremonies,
      start: vi.fn(async () => requestOptions),
      onAssertion: vi.fn(async () => ({ success: true as const })),
    });
    const lockedOut: boolean[] = [];
    autofill.state.subscribe(() => {
      if (autofill.state.get().status === "signingIn") {
        lockedOut.push(autofill.isAutofillSigningIn());
      }
    });
    autofill.start();
    await flush();
    expect(lockedOut).toEqual([true]);
  });

  test("a restart mid-verification waits for that verification, and keeps the lock", async () => {
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(async () => ({
        success: true as const,
        response: authenticationResponse,
      })),
    });
    const verifications: Array<(outcome: { success: true }) => void> = [];
    const onAssertion = vi.fn(
      () =>
        new Promise<{ success: true }>((resolve) =>
          verifications.push(resolve),
        ),
    );
    const autofill = createPasskeyAutofill({
      ceremonies,
      start: vi.fn(async () => requestOptions),
      onAssertion,
    });
    autofill.start();
    await flush();
    expect(onAssertion).toHaveBeenCalledTimes(1);

    // A restart while the first pick verifies asks for no second pick yet.
    autofill.start();
    await flush();
    expect(onAssertion).toHaveBeenCalledTimes(1);
    expect(autofill.isAutofillSigningIn()).toBe(true);
    expect(autofill.state.get().status).toBe("signingIn");

    // Once it ends, the new loop takes over, and the lock follows its pick.
    verifications[0]({ success: true });
    await flush();
    expect(onAssertion).toHaveBeenCalledTimes(2);
    expect(autofill.isAutofillSigningIn()).toBe(true);
    verifications[1]({ success: true });
    await flush();
    expect(autofill.isAutofillSigningIn()).toBe(false);
    expect(autofill.state.get().status).toBe("signedIn");
  });

  test("a stop settles the state: idle while waiting, the pick's end while verifying", async () => {
    const waiting = createPasskeyAutofill({
      ceremonies: fakeCeremonies(),
      start: vi.fn(async () => requestOptions),
      onAssertion: vi.fn(),
    });
    const stopWaiting = waiting.start();
    await flush();
    expect(waiting.state.get().status).toBe("waiting");
    stopWaiting();
    await flush();
    expect(waiting.state.get().status).toBe("idle");

    // A restart in the same tick, like an effect that runs again, stays on
    // "waiting".
    const stopAgain = waiting.start();
    await flush();
    const statuses: string[] = [];
    waiting.state.subscribe(() => statuses.push(waiting.state.get().status));
    stopAgain();
    const stopLast = waiting.start();
    await flush();
    expect(statuses).not.toContain("idle");
    expect(waiting.state.get().status).toBe("waiting");
    stopLast();

    let fail!: (outcome: {
      success: false;
      userError: { error: "OTHER_ERROR"; cause: unknown };
    }) => void;
    const verifying = createPasskeyAutofill<{
      error: "OTHER_ERROR";
      cause: unknown;
    }>({
      ceremonies: fakeCeremonies({
        authenticateWithAutofill: vi.fn(async () => ({
          success: true as const,
          response: authenticationResponse,
        })),
      }),
      start: vi.fn(async () => requestOptions),
      onAssertion: vi.fn(
        () =>
          new Promise<{
            success: false;
            userError: { error: "OTHER_ERROR"; cause: unknown };
          }>((resolve) => (fail = resolve)),
      ),
    });
    const stopVerifying = verifying.start();
    await flush();
    stopVerifying();
    expect(verifying.state.get().status).toBe("signingIn");
    fail({ success: false, userError: { error: "OTHER_ERROR", cause: 1 } });
    await flush();
    expect(verifying.state.get()).toMatchObject({
      status: "idle",
      lastError: { error: "OTHER_ERROR" },
    });
    expect(verifying.isAutofillSigningIn()).toBe(false);
  });

  test("a loop parked on a pause leaves signingIn once an older pick ends", async () => {
    let succeed!: (outcome: { success: true }) => void;
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(async () => ({
        success: true as const,
        response: authenticationResponse,
      })),
    });
    const autofill = createPasskeyAutofill({
      ceremonies,
      start: vi.fn(async () => requestOptions),
      onAssertion: vi.fn(
        () => new Promise<{ success: true }>((resolve) => (succeed = resolve)),
      ),
    });
    autofill.start();
    await flush();
    autofill.start();
    autofill.pauseAutofillFlow();
    await flush();
    expect(autofill.state.get().status).toBe("signingIn");

    const requests = vi.mocked(ceremonies.authenticateWithAutofill).mock.calls
      .length;
    succeed({ success: true });
    await flush();
    expect(autofill.isAutofillSigningIn()).toBe(false);
    expect(autofill.state.get().status).toBe("waiting");
    // Still parked: no new request until the resume.
    expect(ceremonies.authenticateWithAutofill).toHaveBeenCalledTimes(requests);
    autofill.resumeAutofillFlow();
    await flush();
    expect(ceremonies.authenticateWithAutofill).toHaveBeenCalledTimes(
      requests + 1,
    );
  });

  test("a thrown verification unlocks before it reports stopped", async () => {
    const autofill = createPasskeyAutofill({
      ceremonies: fakeCeremonies({
        authenticateWithAutofill: vi.fn(async () => ({
          success: true as const,
          response: authenticationResponse,
        })),
      }),
      start: vi.fn(async () => requestOptions),
      onAssertion: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    const lockedOnStop: boolean[] = [];
    autofill.state.subscribe(() => {
      if (autofill.state.get().status === "stopped") {
        lockedOnStop.push(autofill.isAutofillSigningIn());
      }
    });
    autofill.start();
    await flush();
    expect(lockedOnStop).toEqual([false]);
  });

  test("a stop, a start and a stop in one tick end on idle", async () => {
    const autofill = createPasskeyAutofill({
      ceremonies: fakeCeremonies(),
      start: vi.fn(async () => requestOptions),
      onAssertion: vi.fn(),
    });
    const first = autofill.start();
    await flush();
    first();
    const second = autofill.start();
    second();
    await flush();
    expect(autofill.state.get().status).toBe("idle");
  });

  describe("a pick that verifies while a newer loop finds no autofill", () => {
    function setup() {
      let available = true;
      let succeed!: (outcome: { success: true }) => void;
      const autofill = createPasskeyAutofill({
        ceremonies: fakeCeremonies({
          isAutofillAvailable: vi.fn(async () => available),
          authenticateWithAutofill: vi.fn(async () => ({
            success: true as const,
            response: authenticationResponse,
          })),
        }),
        start: vi.fn(async () => requestOptions),
        onAssertion: vi.fn(
          () =>
            new Promise<{ success: true }>((resolve) => (succeed = resolve)),
        ),
      });
      autofill.start();
      return {
        autofill,
        restartUnavailable: async () => {
          await flush();
          available = false;
          const stop = autofill.start();
          await flush();
          expect(autofill.state.get().status).toBe("stopped");
          return stop;
        },
        succeed: () => succeed({ success: true }),
      };
    }

    test("keeps the newer loop's stopped while it is not stopped", async () => {
      const { autofill, restartUnavailable, succeed } = setup();
      await restartUnavailable();
      succeed();
      await flush();
      expect(autofill.state.get().status).toBe("stopped");
    });

    test("reports its end once the newer loop is stopped too", async () => {
      const { autofill, restartUnavailable, succeed } = setup();
      const stop = await restartUnavailable();
      stop();
      succeed();
      await flush();
      expect(autofill.state.get()).toMatchObject({
        status: "signedIn",
        lastError: null,
      });
    });
  });
});

describe("createPasskeyCeremonySlot", () => {
  const gates = () => {
    const calls: string[] = [];
    return {
      calls,
      autofill: {
        pauseAutofillFlow: () => calls.push("pause"),
        resumeAutofillFlow: () => calls.push("resume"),
        isAutofillSigningIn: () => false,
      },
    };
  };

  test("runs one ceremony at a time, and tracks pending", async () => {
    const { calls, autofill } = gates();
    const slot = createPasskeyCeremonySlot({ autofill });
    const seen: boolean[] = [];
    slot.pending.subscribe(() => seen.push(slot.pending.get()));

    let finish!: (value: string) => void;
    const first = slot.run(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    expect(slot.pending.get()).toBe(true);
    const second = vi.fn(async () => "second");
    expect(await slot.run(second)).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(second).not.toHaveBeenCalled();

    finish("done");
    expect(await first).toBe("done");
    expect(slot.pending.get()).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(calls).toEqual(["pause", "resume"]);
  });

  test("folds a thrown value, and resumes autofill", async () => {
    const { calls, autofill } = gates();
    const slot = createPasskeyCeremonySlot({ autofill });
    const cause = new Error("boom");
    expect(
      await slot.run(async () => {
        throw cause;
      }),
    ).toEqual({ success: false, userError: { error: "OTHER_ERROR", cause } });
    expect(calls).toEqual(["pause", "resume"]);
  });

  test("refuses while the server verifies an autofill sign-in", async () => {
    const slot = createPasskeyCeremonySlot({
      autofill: { ...gates().autofill, isAutofillSigningIn: () => true },
    });
    const fn = vi.fn(async () => "done");
    expect(await slot.run(fn)).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

type Mutation = (args: unknown) => Promise<unknown>;

/** Mocks behind the two transports, dispatching on the function name. */
function transports() {
  const mutations: Record<string, ReturnType<typeof vi.fn<Mutation>>> = {};
  const run = (fn: FunctionReference<"mutation">, args: unknown) => {
    const name = getFunctionName(fn).split(":")[1];
    mutations[name] ??= vi.fn<Mutation>();
    return mutations[name](args);
  };
  const mock = (name: string) => {
    mutations[name] ??= vi.fn<Mutation>();
    return mutations[name];
  };
  return {
    mock,
    convex: { mutation: run } as never,
    signInApi: { mutation: run } as unknown as AuthSignInApi,
  };
}

describe("createSignInWithUsernamePasskey", () => {
  function setup(ceremonies = fakeCeremonies()) {
    const t = transports();
    const setSession = vi.fn(async () => {});
    const client = createSignInWithUsernamePasskey({
      authClient: { setSession },
      signInApi: t.signInApi,
      convex: t.convex,
      api: anyApi.auth as unknown as UsernamePasskeyApi,
      ceremonies,
    });
    return { ...t, setSession, client, ceremonies };
  }

  test("signs up a new username with a new passkey", async () => {
    const { mock, client, setSession, ceremonies } = setup();
    mock("startSignInWithUsernamePasskey").mockResolvedValue({
      success: true,
      step: "register",
      options: creationOptions,
    });
    mock("finishSignUpWithUsernamePasskey").mockResolvedValue({
      status: "complete",
      tokens: bundle,
    });

    const result = await client.signIn({ username: "ada" });

    expect(result).toEqual({
      status: "complete",
      tokens: bundle,
      flow: "signUp",
    });
    expect(ceremonies.register).toHaveBeenCalledWith(creationOptions);
    expect(mock("finishSignUpWithUsernamePasskey")).toHaveBeenCalledWith({
      username: "ada",
      response: registrationResponse,
    });
    expect(setSession).toHaveBeenCalledWith(bundle);
  });

  test("signs in a known username with its passkey", async () => {
    const { mock, client, setSession, ceremonies } = setup();
    mock("startSignInWithUsernamePasskey").mockResolvedValue({
      success: true,
      step: "authenticate",
      options: requestOptions,
    });
    mock("finishSignInWithUsernamePasskey").mockResolvedValue({
      status: "complete",
      tokens: bundle,
    });
    expect(await client.signIn({ username: "ada" })).toEqual({
      status: "complete",
      tokens: bundle,
      flow: "signIn",
    });
    expect(mock("startSignInWithUsernamePasskey")).toHaveBeenCalledWith({
      username: "ada",
    });
    expect(ceremonies.authenticate).toHaveBeenCalledWith(requestOptions);
    expect(ceremonies.register).not.toHaveBeenCalled();
    expect(mock("finishSignInWithUsernamePasskey")).toHaveBeenCalledWith({
      response: authenticationResponse,
    });
    expect(setSession).toHaveBeenCalledWith(bundle);
  });

  test("re-wraps the failures in the sign-in envelope", async () => {
    const unsupported = setup(fakeCeremonies({ isSupported: () => false }));
    expect(await unsupported.client.signIn({ username: "ada" })).toEqual({
      status: "error",
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });

    const { mock, client } = setup();
    const cause = new Error("boom");
    mock("startSignInWithUsernamePasskey").mockRejectedValue(cause);
    expect(await client.signIn({ username: "ada" })).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("is pending while signIn runs, and refuses a second call", async () => {
    const { mock, client } = setup();
    let resolveStart!: (value: unknown) => void;
    mock("startSignInWithUsernamePasskey").mockReturnValue(
      new Promise((resolve) => (resolveStart = resolve)),
    );
    const listener = vi.fn();
    client.pending.subscribe(listener);

    const first = client.signIn({ username: "ada" });
    expect(client.pending.get()).toBe(true);
    expect(await client.signIn({ username: "ada" })).toEqual({
      status: "error",
      userError: { error: "ALREADY_PENDING" },
    });

    resolveStart({
      success: false,
      userError: { error: "INVALID_USERNAME" },
    });
    expect(await first).toEqual({
      status: "error",
      userError: { error: "INVALID_USERNAME" },
    });
    expect(client.pending.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("signs in through autofill, pending while the server verifies", async () => {
    const ceremonies = fakeCeremonies({
      authenticateWithAutofill: vi.fn(async () => ({
        success: true as const,
        response: authenticationResponse,
      })),
    });
    const { mock, client, setSession } = setup(ceremonies);
    mock("startAutofillSignInWithUsernamePasskey").mockResolvedValue({
      options: requestOptions,
    });
    let finish!: (value: unknown) => void;
    mock("finishSignInWithUsernamePasskey").mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );

    const stop = client.startAutofill();
    await flush();
    expect(client.autofill.get().status).toBe("signingIn");
    expect(client.pending.get()).toBe(true);
    expect(await client.signIn({ username: "ada" })).toEqual({
      status: "error",
      userError: { error: "ALREADY_PENDING" },
    });

    finish({ status: "complete", tokens: bundle });
    await flush();
    expect(client.autofill.get()).toEqual({
      available: true,
      status: "signedIn",
      lastError: null,
    });
    expect(client.pending.get()).toBe(false);
    expect(setSession).toHaveBeenCalledWith(bundle);
    expect(mock("finishSignInWithUsernamePasskey")).toHaveBeenCalledWith({
      response: authenticationResponse,
    });
    stop();
  });

  test("a modal sign-in pauses the autofill request", async () => {
    const ceremonies = fakeCeremonies();
    const { mock, client } = setup(ceremonies);
    mock("startAutofillSignInWithUsernamePasskey").mockResolvedValue({
      options: requestOptions,
    });
    const stop = client.startAutofill();
    await flush();
    expect(client.autofill.get().status).toBe("waiting");

    mock("startSignInWithUsernamePasskey").mockResolvedValue({
      success: true,
      step: "authenticate",
      options: requestOptions,
    });
    mock("finishSignInWithUsernamePasskey").mockResolvedValue({
      status: "error",
      userError: { error: "VERIFICATION_FAILED" },
    });
    await client.signIn({ username: "ada" });
    const signal = vi.mocked(ceremonies.authenticateWithAutofill).mock
      .calls[0][1];
    expect(signal.aborted).toBe(true);

    // The resume lets the loop start a fresh request.
    await flush();
    expect(
      mock("startAutofillSignInWithUsernamePasskey"),
    ).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("passkey management", () => {
  test("createAddPasskey re-authenticates, then registers", async () => {
    const { mock, convex } = transports();
    const ceremonies = fakeCeremonies();
    const client = createAddPasskey({
      convex,
      api: anyApi.auth as unknown as AddPasskeyApi,
      ceremonies,
    });
    mock("startAddPasskey").mockResolvedValue({
      success: true,
      options: requestOptions,
    });
    mock("verifyAddPasskey").mockResolvedValue({
      success: true,
      options: creationOptions,
    });
    mock("finishAddPasskey").mockResolvedValue({
      success: true,
      passkeyId: "pk-1",
    });

    const running = client.addPasskey();
    expect(client.pending.get()).toBe(true);
    expect(await running).toEqual({ success: true, passkeyId: "pk-1" });
    expect(client.pending.get()).toBe(false);
    expect(mock("startAddPasskey")).toHaveBeenCalledWith({});
    expect(ceremonies.authenticate).toHaveBeenCalledWith(requestOptions);
    expect(mock("verifyAddPasskey")).toHaveBeenCalledWith({
      response: authenticationResponse,
    });
    expect(ceremonies.register).toHaveBeenCalledWith(creationOptions);
    expect(mock("finishAddPasskey")).toHaveBeenCalledWith({
      response: registrationResponse,
    });
    // Re-authenticate first, then register.
    expect(
      vi.mocked(ceremonies.authenticate).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(ceremonies.register).mock.invocationCallOrder[0]);
  });

  test("createRemovePasskey authenticates, then removes", async () => {
    const { mock, convex } = transports();
    const ceremonies = fakeCeremonies();
    const client = createRemovePasskey({
      convex,
      api: anyApi.auth as unknown as RemovePasskeyApi,
      ceremonies,
    });
    mock("startRemovePasskey").mockResolvedValue({
      success: true,
      options: requestOptions,
    });
    mock("finishRemovePasskey").mockResolvedValue({ success: true });

    expect(await client.removePasskey("pk-1")).toEqual({ success: true });
    expect(mock("startRemovePasskey")).toHaveBeenCalledWith({
      passkeyId: "pk-1",
    });
    expect(ceremonies.authenticate).toHaveBeenCalledWith(requestOptions);
    expect(mock("finishRemovePasskey")).toHaveBeenCalledWith({
      passkeyId: "pk-1",
      response: authenticationResponse,
    });
  });

  test("a failed ceremony and a thrown mutation come back as results", async () => {
    const { mock, convex } = transports();
    const client = createRemovePasskey({
      convex,
      api: anyApi.auth as unknown as RemovePasskeyApi,
      ceremonies: fakeCeremonies({ authenticate: vi.fn(async () => aborted) }),
    });
    mock("startRemovePasskey").mockResolvedValue({
      success: true,
      options: requestOptions,
    });
    expect(await client.removePasskey("pk-1")).toEqual(aborted);

    const cause = new Error("boom");
    mock("startRemovePasskey").mockRejectedValue(cause);
    expect(await client.removePasskey("pk-1")).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
  });
});
