/**
 * Actions on demand: the viewer asks for one of the actions that the
 * project's scenario module declares, and the recorder performs it in the
 * real page, one at a time.
 *
 * The recorder core knows nothing of the app. A scenario module declares its
 * actions ({@link PageActions}): for each, a label, when it applies given what
 * the module observes in the page, and how to perform it with Playwright. The
 * module also says what it observes ({@link PageActions.observe}), from the
 * page itself and from the step reports that the page logged. The
 * {@link ActionRunner} calls these, marks each action in the timeline with
 * two {@link ScenarioEvent}s (its start and its end, with its outcome), and
 * publishes the state of the controls ({@link ControlsState}) after each
 * change. Nothing of a request reaches the page but the id of an action from
 * the declared list.
 *
 * Node-only.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import type { Frame, Page } from "playwright-core";
import type {
  ActionOutcome,
  PageStepEvent,
  ScenarioEvent,
  TimelineEvent,
} from "./events.ts";
import { scrubText } from "./redact.ts";

/** What a module observed in the page, for the controls and its actions. */
export type Observed = {
  /** Whether the page has a signed-in user; null when it cannot tell. */
  signedIn: boolean | null;
  /** Whether the page is loading its state. */
  loading: boolean;
  /** The path of the page, e.g. "/login". */
  page: string;
};

export type ActionContext = {
  page: Page;
  /** The frame of the app's page. */
  frame: Frame;
  /** Loads the app's page again. */
  reload(): Promise<void>;
  baseUrl: string;
  /** A secret to type, registered so that it never reaches the timeline. */
  newSecret(prefix: string): string;
  /** A short string unique to each call. */
  unique(): string;
  /** What was observed in the page just before the action. */
  observed: Observed;
};

export type PageAction<Memory> = {
  /** A stable id, e.g. "signIn". */
  id: string;
  /** The label of its button, e.g. "Sign in". */
  label: string;
  /**
   * Why the action does not apply now, or null when it does. Decided from
   * what was observed in the page and from the module's memory (such as the
   * credentials of the account it signed up).
   */
  unavailable(observed: Observed, memory: Memory): string | null;
  /**
   * Performs the action. Resolves to what the page showed at its end, e.g.
   * "signed in"; throws when the page did not get there.
   */
  run(ctx: ActionContext, memory: Memory): Promise<string>;
  /** The longest the action may take, in ms. Default 30 000. */
  timeoutMs?: number;
};

/** The actions of a scenario module. */
export type PageActions<Memory = unknown> = {
  /** A fresh memory, at the start of a recording. */
  memory(): Memory;
  /**
   * Reads the state of the app from the page (`frame`) and from the newest
   * step reports of the page (`steps`, oldest first). Called after the page
   * did something and after each action.
   */
  observe(
    frame: Frame,
    steps: readonly PageStepEvent[],
    memory: Memory,
  ): Promise<Observed>;
  /** The username in use, for the controls; never a password. */
  username(memory: Memory): string | null;
  actions: readonly PageAction<Memory>[];
};

/** One button of the controls. */
export type ControlState = {
  id: string;
  label: string;
  enabled: boolean;
  /** Why it is disabled, or null. */
  reason: string | null;
};

/** What the viewer's controls show; sent on the stream, never written. */
export type ControlsState = {
  /** The action running now. */
  busy: string | null;
  username: string | null;
  observed: Observed;
  actions: ControlState[];
};

/** Why {@link ActionRunner.request} refused an action. */
export type Refusal = "unknown" | "busy" | "unavailable" | "not ready";

const DEFAULT_TIMEOUT_MS = 30_000;
/** How many step reports of the page an observation gets. */
const STEPS_KEPT = 50;
const UNKNOWN: Observed = { signedIn: null, loading: true, page: "" };

export type ActionRunnerOptions<Memory> = {
  actions: PageActions<Memory>;
  /** The scenario module's name, in the events. */
  scenario: string;
  page: Page;
  frame: Frame;
  reload(): Promise<void>;
  baseUrl: string;
  emit(events: TimelineEvent[]): void;
  /** Gets each secret an action made up, as the recorder's other secrets. */
  onSecret(value: string): void;
  /** Gets the state of the controls after each change. */
  publish(state: ControlsState): void;
  log?(message: string): void;
};

export class ActionRunner<Memory = unknown> {
  private readonly memory: Memory;
  private readonly steps: PageStepEvent[] = [];
  private observed: Observed = UNKNOWN;
  private busy: string | null = null;
  private runs = 0;
  private observing: Promise<void> | null = null;
  private observeAgain = false;
  private closed = false;
  private last = "";
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: ActionRunnerOptions<Memory>) {
    this.memory = options.actions.memory();
    // What the page shows can change with no event (a timer of the page):
    // look again now and then.
    this.timer = setInterval(() => this.refresh(), 1000);
    this.timer.unref?.();
    this.refresh();
  }

  /** Feeds the events of the page: a step report or a navigation. */
  see(events: readonly TimelineEvent[]): void {
    let changed = false;
    for (const event of events) {
      if (event.kind === "step" && event.from === "page") {
        this.steps.push(event);
        if (this.steps.length > STEPS_KEPT) this.steps.shift();
        changed = true;
      } else if (event.kind === "page") {
        changed = true;
      }
    }
    if (changed) this.refresh();
  }

  /** The state of the controls now. */
  state(): ControlsState {
    const { actions } = this.options.actions;
    return {
      busy: this.busy,
      username: this.options.actions.username(this.memory),
      observed: this.observed,
      actions: actions.map((action) => {
        const reason =
          this.busy !== null
            ? this.busy === action.id
              ? "running"
              : "another action is running"
            : this.observed === UNKNOWN
              ? "the page is not ready"
              : action.unavailable(this.observed, this.memory);
        return {
          id: action.id,
          label: action.label,
          enabled: reason === null,
          reason,
        };
      }),
    };
  }

  /**
   * Starts the action `id` if it applies now. Resolves at once with null
   * when it started, or with why it did not; the action itself runs on.
   */
  request(id: string): Refusal | null {
    const action = this.options.actions.actions.find((a) => a.id === id);
    if (action === undefined) return "unknown";
    if (this.closed) return "not ready";
    if (this.busy !== null) return "busy";
    if (this.observed === UNKNOWN) return "not ready";
    if (action.unavailable(this.observed, this.memory) !== null)
      return "unavailable";
    this.busy = id;
    this.publish();
    void this.perform(action);
    return null;
  }

  /** Waits for the action running now, if any. */
  async idle(): Promise<void> {
    while (this.busy !== null) await sleep(50);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private async perform(action: PageAction<Memory>): Promise<void> {
    const { options } = this;
    const run = ++this.runs;
    const event = (
      status: ScenarioEvent["status"],
      outcome: ActionOutcome | null,
      result: string | null,
      error: string | null,
    ): ScenarioEvent => ({
      kind: "scenario",
      id: `action#${run}:${status === "start" ? "start" : "end"}`,
      time: Date.now(),
      scenario: options.scenario,
      step: action.label.toLowerCase(),
      status,
      error,
      action: action.id,
      actionRun: run,
      outcome,
      result,
      username: options.actions.username(this.memory),
    });
    options.emit([event("start", null, null, null)]);
    const timeoutMs = action.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((done) => {
      timer = setTimeout(() => done("timeout"), timeoutMs);
    });
    const ctx: ActionContext = {
      page: options.page,
      frame: options.frame,
      reload: options.reload,
      baseUrl: options.baseUrl,
      observed: this.observed,
      unique: () => randomBytes(3).toString("hex"),
      newSecret: (prefix) => {
        const value = `${prefix}-${randomBytes(12).toString("base64url")}`;
        options.onSecret(value);
        return value;
      },
    };
    const running = action.run(ctx, this.memory);
    // A run that loses the race to the timeout ends on its own; its result
    // is dropped.
    running.catch(() => {});
    let end: ScenarioEvent;
    try {
      const result = await Promise.race([running, timedOut]);
      end =
        result === "timeout"
          ? event(
              "error",
              "timeout",
              null,
              `did not finish in ${timeoutMs / 1000} s`,
            )
          : event("end", "ok", scrubText(result), null);
    } catch (error) {
      end = event(
        "error",
        "failed",
        null,
        scrubText(firstLine(error instanceof Error ? error.message : error)),
      );
    } finally {
      clearTimeout(timer);
    }
    options.emit([end]);
    options.log?.(
      `Action ${action.id}: ${end.outcome}${end.result ? ` (${end.result})` : ""}${end.error ? ` (${end.error})` : ""}`,
    );
    // Look at the page before the next action may start.
    await this.observeNow().catch(() => {});
    this.busy = null;
    this.publish();
  }

  /** Observes the page again, coalescing calls made while observing. */
  private refresh(): void {
    if (this.closed) return;
    if (this.observing !== null) {
      this.observeAgain = true;
      return;
    }
    this.observing = this.observeNow()
      .catch(() => {})
      .finally(() => {
        this.observing = null;
        if (this.observeAgain) {
          this.observeAgain = false;
          this.refresh();
        }
      });
  }

  private async observeNow(): Promise<void> {
    const observed = await this.options.actions.observe(
      this.options.frame,
      this.steps,
      this.memory,
    );
    this.observed = observed;
    this.publish();
  }

  private publish(): void {
    const state = this.state();
    const text = JSON.stringify(state);
    // Only changes.
    if (text === this.last) return;
    this.last = text;
    this.options.publish(state);
  }
}

function firstLine(value: unknown): string {
  return String(value).split("\n")[0].slice(0, 300);
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
