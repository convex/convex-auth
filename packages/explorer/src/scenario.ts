/**
 * Scenarios: TypeScript functions that drive a page through steps while the
 * recorder runs, so that a recording can be made again.
 *
 * A scenario is a module whose default export is a {@link Scenario}. The
 * recorder opens the page of `--page`, then runs the scenario on it; each
 * step becomes two {@link ScenarioEvent}s, its start and its end (or its
 * error). The scenario drives the page with Playwright (`ctx.page`) the way
 * a person would: it types, clicks, reloads, and waits.
 *
 * Node-only.
 *
 * @module
 */
import { randomBytes } from "node:crypto";
import type { Frame, Page } from "playwright-core";
import type { ScenarioEvent } from "./events.ts";
import { scrubText } from "./redact.ts";

export type ScenarioContext = {
  /** The page the recorder opened at `baseUrl`, or the stage that shows it. */
  page: Page;
  /**
   * The frame of the app's page: the main frame of `page`, or the frame of
   * the stage that shows it. Drive the app through it.
   */
  frame: Frame;
  /** Loads the app's page again, in its frame. */
  reload(): Promise<void>;
  /** The URL of `--page`. */
  baseUrl: string;
  /**
   * Runs one step. The timeline shows its start and its end; an error ends
   * the scenario.
   */
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
  /**
   * A secret for the scenario to type, such as a password: random, and
   * different on each run. The recorder never writes it; a check gets it to
   * look for it in the timeline.
   */
  newSecret(prefix: string): string;
  /** A short string unique to this run, e.g. for a username. */
  unique: string;
};

export type Scenario = {
  /** The name of the scenario, in its events. */
  name: string;
  /** What the scenario does, for `--help`. */
  description: string;
  run(ctx: ScenarioContext): Promise<void>;
};

/**
 * Runs a scenario. `emit` receives its events; `onSecret` each secret it
 * made up.
 */
export async function runScenario(
  scenario: Scenario,
  page: Page,
  frame: Frame | Promise<Frame>,
  baseUrl: string,
  emit: (event: ScenarioEvent) => void,
  onSecret?: (value: string) => void,
): Promise<void> {
  let count = 0;
  const event = (
    step: string,
    status: ScenarioEvent["status"],
    error: string | null = null,
  ) =>
    emit({
      kind: "scenario",
      id: `scenario#${++count}`,
      time: Date.now(),
      scenario: scenario.name,
      step,
      status,
      error,
    });
  const screen = await frame;
  await scenario.run({
    page,
    frame: screen,
    async reload() {
      if (screen === page.mainFrame()) {
        await page.reload();
      } else {
        await screen.goto(screen.url());
      }
    },
    baseUrl,
    unique: randomBytes(3).toString("hex"),
    newSecret(prefix) {
      const value = `${prefix}-${randomBytes(12).toString("base64url")}`;
      onSecret?.(value);
      return value;
    },
    async step(name, run) {
      event(name, "start");
      try {
        const result = await run();
        event(name, "end");
        return result;
      } catch (error) {
        event(
          name,
          "error",
          scrubText(error instanceof Error ? error.message : String(error)),
        );
        throw error;
      }
    },
  });
}
