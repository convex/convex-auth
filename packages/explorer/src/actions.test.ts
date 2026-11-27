// @vitest-environment node
import type { Frame, Page } from "playwright-core";
import { afterEach, describe, expect, test } from "vitest";
import {
  ActionRunner,
  type ControlsState,
  type Observed,
  type PageActions,
} from "./actions.ts";
import type { ScenarioEvent, TimelineEvent } from "./events.ts";

type Memory = { signedUp: boolean; signedIn: boolean };

const waitUntil = async (holds: () => boolean) => {
  for (let i = 0; i < 200 && !holds(); i++)
    await new Promise((done) => setTimeout(done, 10));
  expect(holds()).toBe(true);
};

function setup(overrides: Partial<PageActions<Memory>> = {}) {
  const events: TimelineEvent[] = [];
  const states: ControlsState[] = [];
  const secrets: string[] = [];
  let release: () => void = () => {};
  const actions: PageActions<Memory> = {
    memory: () => ({ signedUp: false, signedIn: false }),
    username: (m) => (m.signedUp ? "explorer-abc" : null),
    observe: async (_frame, _steps, m): Promise<Observed> => ({
      signedIn: m.signedIn,
      loading: false,
      page: "/",
    }),
    actions: [
      {
        id: "signUp",
        label: "Sign up",
        unavailable: (o) => (o.signedIn ? "signed in" : null),
        async run(ctx, m) {
          ctx.newSecret("pw");
          await new Promise<void>((done) => (release = done));
          m.signedUp = true;
          m.signedIn = true;
          return "signed in";
        },
      },
      {
        id: "echo",
        label: "Echo",
        unavailable: () => null,
        // A page that shows the typed password back, in its result or in
        // the error of a failed step.
        async run(ctx) {
          const secret = ctx.newSecret("pw");
          if (ctx.observed.page === "/fail")
            throw new Error(`no field for ${secret}`);
          return `welcome ${secret}`;
        },
      },
      {
        id: "broken",
        label: "Broken",
        unavailable: () => null,
        run: async () => {
          throw new Error("no button\nstack");
        },
      },
      {
        id: "slow",
        label: "Slow",
        timeoutMs: 50,
        unavailable: () => null,
        run: () => new Promise<string>(() => {}),
      },
    ],
    ...overrides,
  };
  const runner = new ActionRunner({
    actions,
    scenario: "test-app",
    page: {} as Page,
    frame: {} as Frame,
    reload: async () => {},
    baseUrl: "http://localhost:5173",
    emit: (e) => events.push(...e),
    onSecret: (v) => secrets.push(v),
    publish: (s) => states.push(s),
  });
  return {
    runner,
    events,
    states,
    secrets,
    release: () => release(),
    actionEvents: () => events as ScenarioEvent[],
  };
}

let current: ActionRunner | null = null;
afterEach(() => current?.close());

describe("ActionRunner", () => {
  test("is not ready until it observed the page", async () => {
    const t = setup();
    current = t.runner;
    expect(t.runner.request("signUp")).toBe("not ready");
    await waitUntil(() => t.states.length > 0);
    expect(t.states.at(-1)!.actions[0]).toEqual({
      id: "signUp",
      label: "Sign up",
      enabled: true,
      reason: null,
    });
  });

  test("runs one action at a time and marks its start and end", async () => {
    const t = setup();
    current = t.runner;
    await waitUntil(() => t.states.length > 0);
    expect(t.runner.request("nope")).toBe("unknown");
    expect(t.runner.request("signUp")).toBeNull();
    expect(t.runner.request("broken")).toBe("busy");
    expect(t.states.at(-1)!.busy).toBe("signUp");
    expect(t.states.at(-1)!.actions.map((a) => a.reason)).toEqual([
      "running",
      "another action is running",
      "another action is running",
      "another action is running",
    ]);
    t.release();
    await t.runner.idle();
    const [start, end] = t.actionEvents();
    expect(start).toMatchObject({
      kind: "scenario",
      id: "action#1:start",
      scenario: "test-app",
      step: "sign up",
      status: "start",
      action: "signUp",
      actionRun: 1,
      outcome: null,
    });
    expect(end).toMatchObject({
      id: "action#1:end",
      status: "end",
      outcome: "ok",
      result: "signed in",
      username: "explorer-abc",
      error: null,
    });
    // The secret it typed went to the recorder, not into an event.
    expect(t.secrets).toHaveLength(1);
    expect(JSON.stringify(t.events)).not.toContain(t.secrets[0]);
    // What the page shows now disables it.
    const last = t.states.at(-1)!;
    expect(last.busy).toBeNull();
    expect(last.actions[0]).toMatchObject({
      enabled: false,
      reason: "signed in",
    });
    expect(t.runner.request("signUp")).toBe("unavailable");
  });

  test("a failure and a timeout end with an outcome, and free the runner", async () => {
    const t = setup();
    current = t.runner;
    await waitUntil(() => t.states.length > 0);
    expect(t.runner.request("broken")).toBeNull();
    await t.runner.idle();
    expect(t.runner.request("slow")).toBeNull();
    await t.runner.idle();
    const ends = t.actionEvents().filter((e) => e.status !== "start");
    expect(ends).toMatchObject([
      { status: "error", outcome: "failed", error: "no button" },
      {
        status: "error",
        outcome: "timeout",
        error: "did not finish in 0.05 s",
      },
    ]);
    expect(t.states.at(-1)!.busy).toBeNull();
  });

  test("a secret the action typed never reaches its result or its error", async () => {
    let page = "/";
    const t = setup({
      observe: async () => ({ signedIn: false, loading: false, page }),
    });
    current = t.runner;
    await waitUntil(() => t.states.length > 0);
    expect(t.runner.request("echo")).toBeNull();
    await t.runner.idle();
    page = "/fail";
    await new Promise((done) => setTimeout(done, 1100));
    expect(t.runner.request("echo")).toBeNull();
    await t.runner.idle();
    const ends = t.actionEvents().filter((e) => e.status !== "start");
    expect(ends).toMatchObject([
      { outcome: "ok", result: "welcome [secret]" },
      { outcome: "failed", error: "no field for [secret]" },
    ]);
    expect(t.secrets).toHaveLength(2);
    for (const secret of t.secrets)
      expect(JSON.stringify(t.events)).not.toContain(secret);
  });
});
