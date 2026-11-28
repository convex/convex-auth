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
 * What the call carried rides on the body ({@link OpLoad}): what the
 * request carried from where the body picked it up to the way out, what
 * the response carried from the way out to the storage key whose storage
 * event holds the same label. A token is matched by its label only, which
 * is the same value; nothing else is matched.
 *
 * A step with no operation is not part of one; it lights its module and
 * nothing travels.
 *
 * @module
 */
import type { Derivation, Load, PageItem, Run } from "./recording.ts";
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
/**
 * How much faster what nobody asked for plays: what the client does by
 * itself (a token refreshed on its timer) while no pressed control is under
 * way, when a scenario drove the page. It is real and plays, every step in
 * order; it is not an action, and takes a small share of the time line.
 * Every length of it (its waits, its hops, its runs) is this share of what
 * it would be, so a viewer who asks to watch it plays it at this rate and
 * sees it at the pace of the rest (see `Timeline.quiet`).
 */
export const BRIEF = 0.15;
/** The least shown time between two steps an operation reports at the same place (s). */
export const HOP_SAME = 0.08;

/**
 * One thing the body carries, and when: it rides from `from` to `to` (shown
 * time). One the request carried leaves at the way out; one the response
 * carried is put down at `at`, the storage key that took it, if the body
 * goes there.
 */
export interface OpLoad {
  load: Load;
  dir: "out" | "back";
  from: number;
  to: number;
  /** Where it was picked up (out) or put down (back): a storage key. */
  at?: string;
  /**
   * For one put down: when the key shows it held (shown time), which can
   * be after the body put it down; it rests there until then.
   */
  held?: number;
}

/** How a load is named on hover and in the inspector: its kind and label, never a value. */
export function loadName(l: OpLoad["load"]): string {
  if (l.kind === "redacted")
    return `${l.field} (a field the recorder redacted)`;
  return l.cargo?.label ?? `${l.type} secret ${l.secret}`;
}

/**
 * What a carried thing is called at the moment it is picked up or put
 * down: from the recording's own facts, never its value or its label. A
 * redacted field by its field; a token by the noun the presentation gives
 * its table, else by its field.
 */
export function loadWord(l: OpLoad["load"]): string {
  if (l.kind === "redacted") return `${l.field} · redacted`;
  return l.cargo?.noun ?? l.field;
}

/** How long a carried thing is named where it changed hands (shown s). */
export const NAMED_FOR = 1.6;

/**
 * The moments a carried thing changes hands, in shown time, and how long
 * each is named: going out, at the way out from when the body leaves for
 * it until a little after it gets there; picked up from a key, or put down
 * on one, at that key for {@link NAMED_FOR}.
 */
export function loadMoments(
  op: OpPath,
): { from: number; until: number; anchor: string; load: OpLoad }[] {
  const out: { from: number; until: number; anchor: string; load: OpLoad }[] =
    [];
  const via = op.points.find((p) => p.step === "out")?.anchor;
  for (const l of op.loads) {
    if (l.dir === "out" && l.at)
      out.push({
        from: l.from,
        until: l.from + NAMED_FOR,
        anchor: l.at,
        load: l,
      });
    else if (l.dir === "out" && via)
      out.push({
        from: l.from,
        until: l.to + NAMED_FOR / 2,
        anchor: via,
        load: l,
      });
    else if (l.dir === "back" && l.at)
      out.push({ from: l.to, until: l.to + NAMED_FOR, anchor: l.at, load: l });
  }
  return out.sort((a, b) => a.from - b.from);
}

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
  /** When it first reported an error (shown time): it is red from then on. */
  errorAt?: number;
  /** The code of the error it reported, if the client gave one. */
  code?: string;
  /**
   * The client did it by itself while no pressed control was under way (a
   * token refreshed on its timer): it plays briefly and is drawn quieter.
   */
  unasked?: boolean;
  /** The run of the call it made, when matched by bracket. */
  run?: string;
  /** What its call carried, on the body. */
  loads: OpLoad[];
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
  // Which label each storage key took or gave up: in the page's order of
  // events, and when it is shown.
  const holds: Hold[] = items
    .filter((x) => x.item.hold?.cargo.secret && x.item.order)
    .map((x) => ({
      at: x.at,
      seq: x.item.order!.seq,
      page: x.item.order!.page,
      key: x.item.part,
      op: x.item.hold!.op,
      secret: x.item.hold!.cargo.secret!,
    }))
    .sort((a, b) => a.seq - b.seq);
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
    // The body's visits to storage keys, with the page's order of the step.
    const visits: Visit[] = [];
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
      if (key) {
        points.push({
          at: at + HOP_KEY * (brief.has(id) ? BRIEF : 1),
          anchor: key,
          step: item.step!,
        });
        visits.push({ point: points.at(-1)!, key, order: item.order });
      }
      inKeyOf = key ? item.part : null;
    }
    const path: OpPath = {
      id,
      kind: steps[0].item.opKind ?? "op",
      parent: steps.find((s) => s.item.parentOp)?.item.parentOp,
      points,
      tone: steps.some((s) => s.item.tone === "error") ? "error" : "normal",
      errorAt: steps.find((s) => s.item.tone === "error")?.at,
      code: steps.find((s) => s.item.code)?.item.code,
      loads: [],
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
    if (call && span && call.via)
      path.loads = loadsOf(points, visits, call, span, holds);
    out.push(path);
  }
  return out.sort((a, b) => a.points[0].at - b.points[0].at);
}

interface Hold {
  at: number;
  seq: number;
  page: string;
  key: string;
  op: "gain" | "drop";
  secret: string;
}

interface Visit {
  point: OpPoint;
  key: string;
  order?: { page: string; seq: number };
}

/**
 * What rides on the body of an operation whose call went out at `span`,
 * with the storage keys matched by label in the page's own order of events.
 * Out: from the body's last visit, before the call, of a key that then held
 * the same label, else from the place it left for the way out; to the way
 * out. Back: from the way out to the body's first visit, after the call, of
 * a key that took the same label after the call, else to the end of its
 * path.
 */
function loadsOf(
  points: OpPoint[],
  visits: Visit[],
  call: Run,
  span: CallSpan,
  holds: Hold[],
): OpLoad[] {
  const end = points.at(-1)!.at;
  const outAt = points.findIndex((p) => p.step === "out");
  const leaves = points[Math.max(0, outAt - 1)].at;
  const sent = call.order;
  const heldAt = (key: string, order: { page: string; seq: number }) => {
    let label: string | null = null;
    for (const h of holds) {
      if (h.page !== order.page || h.key !== key) continue;
      if (h.seq > order.seq) break;
      label = h.op === "gain" ? h.secret : null;
    }
    return label;
  };
  const loads: OpLoad[] = [];
  for (const load of call.loadIn ?? []) {
    let from = leaves;
    let at: string | undefined;
    if (load.kind === "secret" && sent)
      for (const v of visits) {
        if (!v.order || v.order.seq > sent.seq || v.point.at >= span.out)
          continue;
        if (heldAt(v.key, v.order) === load.secret) {
          from = v.point.at;
          at = v.key;
        }
      }
    loads.push({ load, dir: "out", from, to: span.out, ...(at ? { at } : {}) });
  }
  for (const load of call.loadOut ?? []) {
    let to = end;
    let at: string | undefined;
    let held: number | undefined;
    if (load.kind === "secret" && sent) {
      const took = holds.filter(
        (h) =>
          h.op === "gain" &&
          h.secret === load.secret &&
          h.page === sent.page &&
          h.seq > sent.seq,
      );
      const visit = visits.find(
        (v) => v.point.at > span.back && took.some((h) => h.key === v.key),
      );
      if (visit) {
        to = visit.point.at;
        at = visit.key;
        held = took.find((h) => h.key === visit.key)!.at;
      }
    }
    loads.push({
      load,
      dir: "back",
      from: span.back,
      to,
      ...(at ? { at, held } : {}),
    });
  }
  return loads;
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
