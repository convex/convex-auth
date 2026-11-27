/**
 * The backend half of an operation of the client: while the call an
 * operation made runs, the part of the backend it is in now (its function,
 * or a function of a component it called) has the same halo as the module
 * of the client acting now (`Browser.tsx`), and its name beside it
 * (`Labels.tsx`), so that the eye can follow a sign-in across to the backend
 * and back. Only the calls of operations: what the page reads by itself
 * (queries run again) has none. A call the client made by itself (a token
 * fetched on its timer) is dimmer and not named.
 *
 * It is drawn from the activations of the run, which its run events and
 * step reports make: nothing here is derived.
 */
import { useMemo } from "react";
import type { ClientStep, Timeline } from "../model/schedule.ts";
import { usePlayback, world } from "../store.ts";
import { actingModules, Halo } from "./Browser.tsx";
import { placementOf, topIsland } from "./look.ts";

/** How dim the halo of a call nobody asked for is. */
const QUIET = 0.45;

export interface Running {
  /** Per call: a stretch per part it was in, the innermost part active then. */
  asked: ClientStep[];
  unasked: ClientStep[];
}

const cache = new WeakMap<Timeline["ops"], Running>();

/**
 * Where the calls of the operations were in the backend, over time: at each
 * moment, of the parts of a run active then (its function, and the
 * functions it called), the one entered last. As stretches, in order of
 * start, for {@link actingModules}.
 */
export function running(tl: Timeline): Running {
  const hit = cache.get(tl.ops);
  if (hit) return hit;
  const out: Running = { asked: [], unasked: [] };
  const client = world.presentation.client;
  for (const op of tl.ops) {
    if (!op.run) continue;
    const run = tl.chapters.find((c) => c.run.id === op.run)?.run;
    const acts = tl.activations.filter(
      (a) =>
        a.run === op.run &&
        a.node !== run?.via &&
        placementOf(a.node) &&
        (!client || topIsland(a.node) !== client),
    );
    const times = [...new Set(acts.flatMap((a) => [a.start, a.end]))].sort(
      (a, b) => a - b,
    );
    const list = op.unasked ? out.unasked : out.asked;
    for (let i = 0; i < times.length - 1; i++) {
      const [from, to] = [times[i], times[i + 1]];
      const inner = acts
        .filter((a) => a.start <= from && a.end >= to)
        .sort((a, b) => b.start - a.start)[0];
      if (!inner) continue;
      const prev = list.at(-1);
      if (prev && prev.part === inner.node && prev.end === from) prev.end = to;
      else
        list.push({
          start: from,
          end: to,
          part: inner.node,
          step: "run",
          tone: inner.tone,
        });
    }
  }
  out.asked.sort((a, b) => a.start - b.start);
  out.unasked.sort((a, b) => a.start - b.start);
  cache.set(tl.ops, out);
  return out;
}

/** The part of the backend an asked call is in now, if any: the one to name. */
export function runningNow(tl: Timeline, t: number): string | null {
  return actingModules(running(tl).asked, t).now;
}

export function RunningHalos() {
  const version = usePlayback((s) => s.version);
  const r = useMemo(() => {
    void version;
    return running(world.timeline);
  }, [version]);
  const ids = usePlayback((s) =>
    [
      ...[...actingModules(r.asked, s.time).on.keys()].map((id) => `a|${id}`),
      ...[...actingModules(r.unasked, s.time).on.keys()].map((id) => `u|${id}`),
    ]
      .sort()
      .join(","),
  );
  return (
    <>
      {ids
        ? ids.split(",").map((key) => {
            const [kind, id] = [key.slice(0, 1), key.slice(2)];
            return (
              <Halo
                key={key}
                part={id}
                steps={kind === "a" ? r.asked : r.unasked}
                quiet={kind === "a" ? 1 : QUIET}
              />
            );
          })
        : null}
    </>
  );
}
