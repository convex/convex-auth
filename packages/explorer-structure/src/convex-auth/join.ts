/**
 * From a step that a recording holds to the places in the source that report
 * it (the model's `steps`), and so to the module and the export it came from.
 * Runs on any runtime: it reads only the model.
 *
 * A client step names the part it reports as (`part`), which is not always
 * the module whose code reported it: `browser/sessionManager` reports the
 * `lock.*` steps as `module:browser/mutex`. A server step names no part; it
 * matches by its name alone.
 *
 * @module
 */
import type { StepSite } from "./model.ts";

/** A step as a recording holds it (a line whose `kind` is `step`). */
export type RecordedStep = {
  step: string;
  /** `browser` for a client step; absent for a server step. */
  runsIn?: string | null;
  /** The part a client step reports as. */
  part?: string | null;
  detail?: Record<string, unknown>;
};

export type StepOrigin = {
  /** The places that can have reported it: one, or several the recording cannot tell apart. */
  sites: StepSite[];
  /** The part that holds those places, when they share one: the module of a client step. */
  part: string | null;
  /** The export that holds them, when they share one. */
  export: string | null;
};

/**
 * The places that can have reported a recorded step. When several match by
 * name and part, the ones whose detail keys cannot hold the recorded ones
 * are dropped, and then the ones that write a literal the recorded detail
 * does not hold (a missing key, or another value).
 */
export function stepSites(
  model: { steps: StepSite[] },
  recorded: RecordedStep,
): StepSite[] {
  const runsIn = recorded.runsIn === "browser" ? "browser" : "server";
  const byName = model.steps.filter(
    (site) =>
      site.step === recorded.step &&
      site.runsIn === runsIn &&
      (runsIn === "server" ||
        site.reportsAs === recorded.part ||
        (site.reportsAsPassedIn?.values.some((v) => v.part === recorded.part) ??
          false)),
  );
  if (byName.length < 2 || recorded.detail === undefined) {
    return byName;
  }
  const keys = Object.keys(recorded.detail);
  const byKeys = byName.filter(
    (site) =>
      site.detailOpen !== undefined ||
      keys.every((key) => site.detailKeys.includes(key)),
  );
  const candidates = byKeys.length === 0 ? byName : byKeys;
  const detail = recorded.detail;
  const byLiterals = candidates.filter((site) =>
    Object.entries(site.detailLiterals ?? {}).every(
      ([key, value]) => key in detail && detail[key] === value,
    ),
  );
  return byLiterals.length === 0 ? candidates : byLiterals;
}

/** Where a recorded step came from, or `null` when no place in the source reports it. */
export function stepOrigin(
  model: { steps: StepSite[] },
  recorded: RecordedStep,
): StepOrigin | null {
  const sites = stepSites(model, recorded);
  if (sites.length === 0) {
    return null;
  }
  const shared = <T>(values: T[]): T | null =>
    values.every((v) => v === values[0]) ? values[0]! : null;
  return {
    sites,
    part: shared(sites.map((s) => s.part)),
    export: shared(sites.map((s) => s.export)),
  };
}
