/**
 * The operations of the client, as one moving thing each.
 *
 * The client library numbers what it does: every step it reports carries
 * the operation it belongs to (`op`, made unique per page and document load
 * by the adapter) and its kind (`opKind`: `signIn`, `tokenFetch`, …). A real
 * sign-in is one operation: `signIn.call` in the React module, the session
 * set in the session manager, two writes in storage, the new state. An
 * operation's steps are not always next to each other in time; several can
 * interleave.
 *
 * An operation is drawn as one thing that moves through the places its
 * steps were reported at, in the order they were reported: the module that
 * reported a step, then the storage key the step names (`detail.key` +
 * `"_"` + `detail.namespace`, which the adapter resolves); from one key of
 * a module straight to the next. Each move takes at least {@link HOP}
 * ({@link HOP_KEY} to or from a key), which the schedule leaves. Where the
 * operation made a call, it goes out with the call to the way out of the
 * browser and comes back with the answer. The link from an operation to its
 * call is not recorded by an id. The one derivation allowed is the bracket
 * rule: when exactly one call left the page between an operation's opening
 * and closing step of a bracket the presentation lists ({@link Bracket}),
 * in the page's own order of events, that is its call. A call matched so
 * says so ({@link OpPath.matched}).
 *
 * A step with no operation is not part of one; it lights its module and
 * nothing travels.
 *
 * @module
 */
import type { Derivation, PageItem, Run } from "./recording.ts";
import type { Tone } from "./recording.ts";

/**
 * The least shown time an operation's body takes to move from one place to
 * the next (s): from a module to the storage key it names, from one module
 * to another, between the module that sent a call and the way out of the
 * browser. Seven places in a third of a second is a flash; this makes each
 * one a place the eye can follow.
 */
export const HOP = 0.33;
/**
 * The least shown time between a module and a storage key inside it, either
 * way (s): a short trip.
 */
export const HOP_KEY = 0.28;
/** The least shown time between two steps an operation reports at the same place (s). */
export const HOP_SAME = 0.08;

/** One place an operation is at, at a shown time. */
export interface OpPoint {
  at: number;
  /** The part it is at. */
  anchor: string;
  /** The step reported there, or what it does there ("out", "back"). */
  step: string;
}

export interface OpPath {
  /** Unique: page, document load and the client's number. */
  id: string;
  kind: string;
  /** The operation that started it, when the client knows. */
  parent?: string;
  /** In shown time, increasing. */
  points: OpPoint[];
  tone: Tone;
  /**
   * The client did it by itself while no pressed control was under way (a
   * token refreshed on its timer): it plays briefly and is drawn quieter.
   */
  unasked?: boolean;
  /** The run of the call it made, when matched by bracket. */
  run?: string;
  matched?: Derivation;
}

export const BRACKET: Derivation = {
  rule: "call-by-bracket",
  note: "The recording does not link the operation to its call. It is the only call of that function the page made between the operation's opening and closing steps, in the page's own order of events (matched by bracket).",
};

/**
 * A bracket an operation can make a call in: its opening and closing
 * steps, whether a query counts, and whether the call must be of the
 * function the opening step names (its `fn`). The project's presentation
 * lists them (`brackets`); the core names no step.
 */
export interface Bracket {
  open: string;
  close: string[];
  queries: boolean;
  sameFunction?: boolean;
}

/** Where a run's call leaves the page and comes back, in shown time. */
export interface CallSpan {
  run: Run;
  /** When it reaches the way out, and leaves it again on the way back. */
  out: number;
  back: number;
  /** When it is back at the module that sent it. */
  home: number;
}

/**
 * Every operation of the client, from the page items at their shown times
 * and the calls of the runs. `calls` has, per run id, where its call is.
 */
export function operations(
  items: { item: PageItem; at: number }[],
  runs: Run[],
  calls: Map<string, CallSpan>,
  brackets: Bracket[] = [],
  /** The operations nobody asked for: brief hops, and drawn quieter. */
  brief: Set<string> = new Set(),
): OpPath[] {
  const byOp = new Map<string, { item: PageItem; at: number }[]>();
  for (const x of items) {
    if (!x.item.op || !x.item.step) continue;
    const list = byOp.get(x.item.op) ?? [];
    list.push(x);
    byOp.set(x.item.op, list);
  }
  const out: OpPath[] = [];
  for (const [id, steps] of byOp) {
    // In the page's own order where recorded.
    steps.sort(
      (a, b) =>
        (a.item.order?.seq ?? 0) - (b.item.order?.seq ?? 0) || a.at - b.at,
    );
    const points: OpPoint[] = [];
    const call = matchCall(steps, runs, brackets);
    const span = call ? calls.get(call.id) : undefined;
    // The module of the key the body was last at, and when.
    let inKeyOf: string | null = null;
    let lastAt = -Infinity;
    for (const { item, at } of steps) {
      // Out with the call and back in between: not at the key any more.
      if (span && lastAt < span.out && at > span.out) inKeyOf = null;
      lastAt = at;
      // The key the step names, one hop after the module (the schedule
      // leaves the time for it). From a key of the same module the body
      // goes straight to the next key, inside the module.
      const key = item.lights?.[1];
      if (!(key && inKeyOf === item.part))
        points.push({ at, anchor: item.part, step: item.step! });
      if (key)
        points.push({
          at: at + HOP_KEY * (brief.has(id) ? 0.5 : 1),
          anchor: key,
          step: item.step!,
        });
      inKeyOf = key ? item.part : null;
    }
    const path: OpPath = {
      id,
      kind: steps[0].item.opKind ?? "op",
      parent: steps.find((s) => s.item.parentOp)?.item.parentOp,
      points,
      tone: steps.some((s) => s.item.tone === "error") ? "error" : "normal",
      ...(brief.has(id) ? { unasked: true } : {}),
    };
    if (call && span) {
      const from = steps.find((s) =>
        brackets.some((b) => b.open === s.item.step),
      )!;
      path.run = call.id;
      path.matched = BRACKET;
      if (call.via) {
        points.push(
          { at: span.out, anchor: call.via, step: "out" },
          { at: span.back, anchor: call.via, step: "back" },
          { at: span.home, anchor: from.item.part, step: "back" },
        );
      }
    }
    points.sort((a, b) => a.at - b.at);
    // Strictly increasing times, so the path is a function of time.
    for (let i = 1; i < points.length; i++)
      if (points[i].at <= points[i - 1].at)
        points[i].at = points[i - 1].at + 1e-3;
    out.push(path);
  }
  return out.sort((a, b) => a.points[0].at - b.points[0].at);
}

/** The bracket rule: the one call inside an operation's bracket, or none. */
function matchCall(
  steps: { item: PageItem }[],
  runs: Run[],
  brackets: Bracket[],
): Run | null {
  for (const b of brackets) {
    const open = steps.find((s) => s.item.step === b.open)?.item;
    const close = steps.find((s) => b.close.includes(s.item.step ?? ""))?.item;
    if (!open?.order || !close?.order) continue;
    const page = open.order.page;
    const fn = b.sameFunction ? functionOf(open) : null;
    const inside = runs.filter(
      (r) =>
        r.order?.page === page &&
        r.order.seq > open.order!.seq &&
        r.order.seq < close.order!.seq &&
        (b.queries || r.type !== "Query") &&
        (fn === null || r.function.endsWith(fn)),
    );
    if (inside.length === 1) return inside[0];
  }
  return null;
}

/**
 * The function a `signIn.call` names (`auth:signIn`, `a/b:f`), as the end
 * of a part id (`…:auth.signIn`, `…:a/b.f`).
 */
function functionOf(item: PageItem): string | null {
  return item.fn ? `:${item.fn.replace(":", ".")}` : null;
}
