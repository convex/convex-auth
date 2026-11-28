/**
 * Lays a recording out on a timeline at human speed.
 *
 * A recorded run takes milliseconds; a person needs seconds to follow it. The
 * schedule keeps the order of the recording and its causality (a call returns
 * before the next one starts, writes commit at the end of their run) and gives
 * each step a duration a person can watch. The real durations stay on the
 * runs, and the UI shows them.
 */
import type { GraphIndex } from "./graph.ts";
import {
  HOP,
  HOP_KEY,
  HOP_SAME,
  operations,
  type Bracket,
  type CallSpan,
  type OpPath,
} from "./operations.ts";

export { HOP, HOP_KEY, HOP_SAME } from "./operations.ts";
import type {
  Cargo,
  Derivation,
  Doc,
  PageItem,
  PageState,
  Recording,
  Run,
  Tone,
  Write,
} from "./recording.ts";

export type { Tone } from "./recording.ts";

/** A part id: where a traveller leaves from or arrives at. */
export type Anchor = string;

export interface Movement {
  id: string;
  run: string;
  kind: "request" | "response" | "call" | "return" | "schedule" | "write";
  from: Anchor;
  to: Anchor;
  start: number;
  end: number;
  label: string;
  detail: string;
  cargo: Cargo[];
  tone: Tone;
  derived?: Derivation;
}

export interface Activation {
  node: string;
  run: string;
  start: number;
  end: number;
  tone: Tone;
}

export interface RowChange {
  at: number;
  run: string;
  write: Write;
}

export interface HoldingChange {
  at: number;
  holder: string;
  cargo: Cargo;
  op: "gain" | "drop";
}

/** A page's sign-in state changes, as its client library reported. */
export interface StateChange {
  at: number;
  holder: string;
  state: PageState;
}

/** A step the client library reported, at the module that reported it. */
export interface ClientStep {
  start: number;
  end: number;
  part: string;
  step: string;
  tone: Tone;
  /** The function the step names, as the page reported it (`auth:signIn`). */
  fn?: string;
}

export interface Beat {
  start: number;
  end: number;
  run: string;
  text: string;
  tone: Tone;
  /** The part the beat is about. */
  focus?: Anchor;
  /** Every part the beat touches, for the camera to frame. */
  frame: Anchor[];
}

export interface Alert {
  start: number;
  end: number;
  run: string;
  part: string;
  level: string;
  text: string;
}

export interface Chapter {
  run: Run;
  title: string;
  /** The step of the scenario it belongs to, if a scenario drove a page. */
  section?: string;
  start: number;
  end: number;
  commitAt: number;
  /** When each of the run's steps plays (shown time), by its index in `run.steps`. */
  stepsAt: number[];
  /** When the response leaves the function, if the run has one. */
  answerAt?: number;
}

/** Something a page did outside the runs, at its shown time. */
export interface PlacedItem {
  at: number;
  item: PageItem;
  /** The run it plays with; null for what the page did before any run. */
  run: string | null;
}

export interface Timeline {
  duration: number;
  chapters: Chapter[];
  beats: Beat[];
  movements: Movement[];
  activations: Activation[];
  rowChanges: RowChange[];
  holdings: HoldingChange[];
  /** When a page finished loading a document (its recorded `load`), by page part. */
  loads: { at: number; page: string }[];
  alerts: Alert[];
  states: StateChange[];
  clientSteps: ClientStep[];
  /** Real time (ms) to shown time (s), for what has no place of its own. */
  warp: Warp;
  /** When each pressed control (a step of the scenario) starts, in shown time. */
  actions: number[];
  /** When each pressed control was done, in shown time. */
  actionEnds: number[];
  /** The operations of the client, one moving thing each. */
  ops: OpPath[];
  /** Everything the pages did outside the runs, in shown order. */
  items: PlacedItem[];
}

/**
 * Seconds of shown time for the parts of a function run. A run takes
 * milliseconds; these make each part long enough to see, and no longer.
 */
export const PACE = {
  request: 0.3,
  call: 0.16,
  inside: 0.06,
  return: 0.14,
  note: 0.12,
  log: 0.5,
  commit: 0.3,
  response: 0.3,
  schedule: 0.4,
  /** A run that shows nothing inside (a query read again): out and back. */
  quick: 0.3,
};

/** Seconds a step the client reported, or another page event, stays lit. */
export const LIT = 0.5;
/** How long the sweep around a page that loaded its document lasts (s). */
export const LOAD_SWEEP = 1.2;
/** How long a reporting module's halo takes to fade after its step (s). */
export const STEP_FADE = 0.35;
/**
 * How long the pulse out of a page's state ring lasts when the state
 * changes, and out of a storage key when it is emptied (s).
 */
export const STATE_PULSE = 0.9;

/**
 * The least shown time between two consecutive things that happened, in
 * seconds: a step of the same operation as the one before it, another
 * page event, a run starting.
 */
export const GAP = { sameOp: 0.08, item: 0.12, run: 0.08, lead: 0.6 };

/** The shown length of a query run again with nothing new to show. */
export const RERUN = 0.7;

/** A real gap up to this (s) is shown as it is. */
const REAL_UP_TO = 0.25;
/** No real gap is shown longer than this (s): a long wait is a short pause. */
export const LONGEST_WAIT = 1.6;

/**
 * The shown length of a real gap, in seconds: as it is up to
 * {@link REAL_UP_TO}, then growing with its logarithm, at most
 * {@link LONGEST_WAIT}. A lock held for 50 s, or a minute of nobody pressing
 * anything, is a pause of a couple of seconds.
 */
export function shownGap(real: number): number {
  if (real <= REAL_UP_TO) return Math.max(0, real);
  return Math.min(
    LONGEST_WAIT,
    REAL_UP_TO + 0.2 * Math.log(1 + (real - REAL_UP_TO) / REAL_UP_TO),
  );
}

/**
 * The map from real time (ms since the epoch) to shown time (s): piecewise
 * linear through `(real[i], shown[i])`, increasing in both.
 */
export interface Warp {
  real: number[];
  shown: number[];
}

/** The shown time of a real time, through a warp. */
export function shownAt(w: Warp, real: number): number {
  const n = w.real.length;
  if (n === 0) return 0;
  if (real <= w.real[0]) return w.shown[0];
  if (real >= w.real[n - 1]) return w.shown[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (w.real[mid] <= real) lo = mid;
    else hi = mid;
  }
  const span = w.real[hi] - w.real[lo];
  const k = span > 0 ? (real - w.real[lo]) / span : 0;
  return w.shown[lo] + k * (w.shown[hi] - w.shown[lo]);
}

/** The real time of a shown time, through a warp: the inverse of {@link shownAt}. */
export function realAt(w: Warp, shown: number): number {
  const n = w.shown.length;
  if (n === 0) return 0;
  if (shown <= w.shown[0]) return w.real[0] - (w.shown[0] - shown) * 1000;
  if (shown >= w.shown[n - 1])
    return w.real[n - 1] + (shown - w.shown[n - 1]) * 1000;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (w.shown[mid] <= shown) lo = mid;
    else hi = mid;
  }
  const span = w.shown[hi] - w.shown[lo];
  const k = span > 0 ? (shown - w.shown[lo]) / span : 0;
  return w.real[lo] + k * (w.real[hi] - w.real[lo]);
}

/** The op a page item belongs to, when the client reported one. */
const opOf = (it: Run["before"][number]) => it.op ?? null;

/** The natural shown length of a run: its parts end to end. */
function naturalLength(run: Run): number {
  if (!run.steps.length && !run.writes.length) return 2 * PACE.quick;
  let t = run.scheduledBy ? PACE.schedule : PACE.request;
  for (const s of run.steps)
    t +=
      s.kind === "call"
        ? PACE.call + PACE.inside
        : s.kind === "return"
          ? PACE.return
          : s.kind === "note"
            ? PACE.note
            : PACE.log;
  if (run.writes.length) t += PACE.commit;
  if (!run.scheduledBy) t += PACE.response;
  return t;
}

/**
 * The shown time of the leg between the module that sent a call and the way
 * out of the browser, each way: {@link HOP} for a call that went out by one,
 * none otherwise (a query run again keeps its short leg inside its parts).
 */
function browserLeg(run: Run, rerun?: Set<string>): number {
  const quick = !run.steps.length && !run.writes.length;
  return run.via && !run.scheduledBy && !quick && !rerun?.has(run.id)
    ? HOP * (unasked.has(run) ? BRIEF : 1)
    : 0;
}

/**
 * How much faster what nobody asked for plays: what the client does by
 * itself (a token refreshed on its timer) while no pressed control is under
 * way, when a scenario drove the page. It is real and plays; it is not an
 * action, and passes by quickly.
 */
export const BRIEF = 0.5;
/** The runs nobody asked for (see {@link BRIEF}), for the timeline being built. */
let unasked = new WeakSet<Run>();

/**
 * The real spans of the pressed controls: from a scenario step's start to
 * its end. None when no scenario drove the page.
 */
function pressedSpans(recording: Recording): [number, number][] {
  const items = recording.runs
    .flatMap((r) => [...r.before, ...r.after])
    .filter((i) => i.scenario)
    .sort((a, b) => a.time - b.time);
  const out: [number, number][] = [];
  let open: number | null = null;
  for (const i of items)
    if (i.scenario === "start") open ??= i.time;
    else if (open !== null) {
      out.push([open, i.time]);
      open = null;
    }
  if (open !== null) out.push([open, Infinity]);
  return out;
}

/**
 * Whether a run is a query run again: a query that wrote nothing, of a
 * function the same caller ran before. A subscribed query runs again after
 * every change; each time it plays briefly.
 */
function reruns(runs: Run[]): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
    const key = `${r.caller}|${r.function}`;
    if (r.type === "Query" && !r.writes.length && seen.has(key)) out.add(r.id);
    seen.add(key);
  }
  return out;
}

/**
 * How much a run's parts are scaled to fit its shown length: 1, or less
 * for a query run again.
 */
function runScale(run: Run, rerun: Set<string>): number {
  const n = naturalLength(run);
  if (rerun.has(run.id) && n > RERUN) return RERUN / n;
  return unasked.has(run) ? BRIEF : 1;
}

/** The shown length of a run: its parts, scaled, and its legs in the browser. */
function runLength(run: Run, rerun: Set<string>): number {
  return naturalLength(run) * runScale(run, rerun) + 2 * browserLeg(run, rerun);
}

type Placed =
  | {
      kind: "item";
      real: number;
      item: Run["before"][number];
      /** The run it plays with; none for what the page did before any run. */
      run: Run | null;
    }
  | { kind: "run"; real: number; run: Run };

/**
 * Where each run and each page event goes in shown time. Everything is
 * taken in real order; each is at least a short gap after the one before
 * it, and a real gap longer than that is shown as {@link shownGap} of it.
 * A run lasts {@link naturalLength} (a query run again, {@link RERUN}); what the page did while it was in flight
 * plays while it plays, and what happened after its answer waits for it.
 * A step of an operation of the client comes no sooner than its body can
 * get there from where it was ({@link HOP}), and a call the page sends
 * leaves after the bodies have reached the keys they were going to.
 * Thus things that happened at the same time play at the same time, and
 * shown time is one increasing function of real time.
 */
function place(
  recording: Recording,
  rerun: Set<string>,
  asked: (real: number) => boolean,
) {
  // The operations nobody asked for: their hops are brief.
  const briefOps = new Set<string>();
  const all: Placed[] = [];
  for (const item of recording.early ?? [])
    all.push({ kind: "item", real: item.time, item, run: null });
  for (const run of recording.runs) {
    for (const item of run.before)
      all.push({ kind: "item", real: item.time, item, run });
    all.push({ kind: "run", real: run.sentAt ?? run.startedAt, run });
    for (const item of run.after)
      all.push({ kind: "item", real: item.time, item, run });
  }
  // A page's own order of events wins over its times, which the recorder
  // takes as the events reach it: along each page's order, an event is
  // taken after the one before it (a microsecond, where their times are
  // equal, so that the sort below cannot put them the other way round).
  const byPage = new Map<string, { p: Placed; seq: number }[]>();
  for (const p of all) {
    const order = p.kind === "item" ? p.item.order : p.run.order;
    if (!order) continue;
    const list = byPage.get(order.page) ?? [];
    list.push({ p, seq: order.seq });
    byPage.set(order.page, list);
  }
  for (const list of byPage.values()) {
    list.sort((a, b) => a.seq - b.seq);
    let floor = -Infinity;
    for (const { p } of list) {
      p.real = Math.max(p.real, floor + 1e-3);
      floor = p.real;
    }
  }
  // In that order; ties keep the adapter's order (the sort is stable).
  all.sort((a, b) => a.real - b.real);
  const at = new Map<Placed, number>();
  const runStart = new Map<string, number>();
  const warp: Warp = { real: [], shown: [] };
  const open: { answer: number; end: number }[] = [];
  // Per operation: when its body is last somewhere, and where.
  const opAt = new Map<
    string,
    { at: number; anchor: string; keyOf?: string; real: number }
  >();
  // The calls the page sent and got answered: an operation whose body may
  // have gone out with one is not still at the key it was at.
  const calls: { sent: number; answer: number; end: number; sender: string }[] =
    [];
  const wentOut = (since: number, now: number) =>
    calls.filter((c) => c.sent >= since && c.answer <= now);
  // When the last body reached the key its step named: a call the page
  // sends next leaves after that.
  let bodiesAt = 0;
  let prev: Placed | null = null;
  let prevShown = 0;
  let last = 0;
  for (const p of all) {
    let s: number;
    if (!prev) s = GAP.lead;
    else {
      const least =
        p.kind === "run"
          ? GAP.run
          : prev.kind === "item" &&
              opOf(p.item) &&
              opOf(p.item) === opOf(prev.item)
            ? GAP.sameOp
            : GAP.item;
      s = prevShown + Math.max(least, shownGap((p.real - prev.real) / 1000));
    }
    // After a run's answer: after the run has played.
    for (let i = open.length - 1; i >= 0; i--)
      if (open[i].answer <= p.real) {
        s = Math.max(s, open[i].end + 0.05);
        open.splice(i, 1);
      }
    // An operation's body has time to get here from where it was.
    const op = p.kind === "item" && p.item.step ? opOf(p.item) : null;
    if (op && p.kind === "item") {
      const last = opAt.get(op);
      if (!last && !asked(p.real)) briefOps.add(op);
      const b = briefOps.has(op) ? BRIEF : 1;
      // A body that may have gone out with a call since is back at the
      // module that sent it when the call is home.
      const back = last ? wentOut(last.real, p.real) : [];
      const was = back.length
        ? {
            ...last!,
            keyOf: undefined,
            at: Math.max(last!.at, ...back.map((c) => c.end)),
            anchor: back.at(-1)!.sender,
          }
        : last;
      const key = p.item.lights?.[1];
      // From a key to another key of the same module, the body goes
      // straight across (see `operations`): the hop is the key's.
      if (was)
        s = Math.max(
          s,
          was.at +
            b *
              (was.anchor === p.item.part
                ? HOP_SAME
                : was.keyOf === p.item.part
                  ? key
                    ? 0
                    : HOP_KEY
                  : HOP),
        );
      opAt.set(
        op,
        key
          ? {
              at: s + b * HOP_KEY,
              anchor: key,
              keyOf: p.item.part,
              real: p.real,
            }
          : { at: s, anchor: p.item.part, real: p.real },
      );
      bodiesAt = Math.max(bodiesAt, key ? s + b * HOP_KEY : s);
    } else if (p.kind === "run") s = Math.max(s, bodiesAt);
    at.set(p, s);
    if (p.kind === "run") {
      runStart.set(p.run.id, s);
      const end = s + runLength(p.run, rerun);
      // A query run again plays briefly beside what follows; nothing waits
      // for it.
      if (!rerun.has(p.run.id) && p.run.via)
        calls.push({
          sent: p.real,
          answer: p.run.answeredAt ?? p.run.endedAt,
          end,
          sender: p.run.sender?.part ?? p.run.caller,
        });
      if (!rerun.has(p.run.id))
        open.push({ answer: p.run.answeredAt ?? p.run.endedAt, end });
      last = Math.max(last, end);
    } else last = Math.max(last, s + LIT);
    // Steps reported in the same millisecond play one after another: each
    // is its own point, a microsecond of real time apart, so that a wait
    // after them starts where they end.
    const lastReal = warp.real.length ? warp.real[warp.real.length - 1] : null;
    if (lastReal === null || p.real > lastReal) {
      warp.real.push(p.real);
      warp.shown.push(s);
    } else if (s > warp.shown[warp.shown.length - 1]) {
      warp.real.push(lastReal + 1e-3);
      warp.shown.push(s);
    }
    prev = p;
    prevShown = s;
  }
  return { all, at, runStart, warp, last, briefOps };
}

export function buildTimeline(
  index: GraphIndex,
  recording: Recording,
  brackets: Bracket[] = [],
): Timeline {
  const tl: Timeline = {
    duration: 0,
    chapters: [],
    beats: [],
    movements: [],
    activations: [],
    rowChanges: [],
    holdings: [],
    loads: [],
    alerts: [],
    states: [],
    clientSteps: [],
    warp: { real: [], shown: [] },
    actions: [],
    actionEnds: [],
    ops: [],
    items: [],
  };
  const name = (id: string) => index.part.get(id)?.label ?? id;
  // Ids count within each run, so that a run keeps the ids of its movements
  // when a live recording grows and runs arrive before it.
  const movementCounts = new Map<string, number>();
  const move = (m: Omit<Movement, "id">) => {
    const n = (movementCounts.get(m.run) ?? 0) + 1;
    movementCounts.set(m.run, n);
    tl.movements.push({ ...m, id: `${m.run}#m${n}` });
  };
  const beat = (
    start: number,
    end: number,
    run: string,
    text: string,
    tone: Tone = "normal",
    focus?: Anchor,
    frame: Anchor[] = focus ? [focus] : [],
  ) => tl.beats.push({ start, end, run, text, tone, focus, frame });

  // The rows the recording started with.
  for (const write of recording.snapshot) {
    tl.rowChanges.push({ at: 0, run: "", write });
  }

  /** Something a page did outside the runs, at its shown time. */
  const playItem = (run: Run | null, it: Run["before"][number], at: number) => {
    // What the page did before any run plays under the id of what did it.
    const id = run?.id ?? it.part;
    const end = at + LIT;
    beat(
      at,
      end,
      id,
      `${name(it.part)}: ${it.text}`,
      it.tone,
      it.part,
      it.lights ?? [it.part],
    );
    for (const node of it.lights ?? [])
      tl.activations.push({ node, run: id, start: at, end, tone: it.tone });
    if (it.step)
      tl.clientSteps.push({
        start: at,
        end,
        part: it.part,
        step: it.step,
        tone: it.tone,
        ...(it.fn ? { fn: it.fn } : {}),
      });
    if (it.state)
      tl.states.push({
        at: at + 0.05,
        holder: it.state.holder,
        state: it.state.state,
      });
    if (it.loaded) tl.loads.push({ at, page: it.part });
    if (it.hold)
      tl.holdings.push({
        at: at + 0.05,
        holder: it.part,
        cargo: it.hold.cargo,
        op: it.hold.op,
      });
  };

  /**
   * The short leg between a caller and the way out it used, inside the
   * browser. Returns when it ends.
   */
  const hop = (
    run: Run,
    from: Anchor,
    to: Anchor,
    start: number,
    kind: "request" | "response",
    end: number,
  ) => {
    move({
      run: run.id,
      kind,
      from,
      to,
      start,
      end,
      label: `${kind} · ${name(to)}`,
      detail: `${name(from)} to ${name(to)}.`,
      cargo: kind === "request" ? run.carriesIn : run.carriesOut,
      tone: kind === "request" ? "normal" : run.tone,
      derived: run.sender?.derived,
    });
    tl.activations.push({
      node: run.via!,
      run: run.id,
      start,
      end,
      tone: "normal",
    });
    return end;
  };

  const rerun = reruns(recording.runs);
  const spans = pressedSpans(recording);
  const asked = (real: number) =>
    !spans.length || spans.some(([a, b]) => real >= a && real <= b);
  unasked = new WeakSet(
    recording.runs.filter((r) => !asked(r.sentAt ?? r.startedAt)),
  );
  const placed = place(recording, rerun, asked);
  // Where each call that left by a way out of the browser is, for the
  // operations that made them.
  const calls = new Map<string, CallSpan>();
  tl.warp = placed.warp;
  for (const p of placed.all)
    if (p.kind === "item") {
      playItem(p.run, p.item, placed.at.get(p)!);
      tl.items.push({
        at: placed.at.get(p)!,
        item: p.item,
        run: p.run?.id ?? null,
      });
      if (p.item.scenario === "start") tl.actions.push(placed.at.get(p)!);
      if (p.item.scenario === "end") tl.actionEnds.push(placed.at.get(p)!);
    }

  for (const run of recording.runs) {
    const start = placed.runStart.get(run.id)!;
    let t = start;
    // A query run again plays its parts faster, to fit its short length.
    const k = runScale(run, rerun);
    const P = Object.fromEntries(
      Object.entries(PACE).map(([key, v]) => [key, v * k]),
    ) as typeof PACE;
    const root = run.function;
    // A run that shows nothing inside (a query read again) passes quickly.
    const quick = !run.steps.length && !run.writes.length;
    const scheduled = Boolean(run.scheduledBy);
    const verb = run.type.toLowerCase();

    // The request, from the caller, out by the way it left (a WebSocket).
    const reqStart = t;
    const leg = browserLeg(run, rerun);
    t += (quick ? P.quick : scheduled ? P.schedule : P.request) + leg;
    const sender = run.sender?.part ?? run.caller;
    const out = run.via
      ? hop(
          run,
          sender,
          run.via,
          reqStart,
          "request",
          reqStart + (leg || (t - reqStart) * 0.35),
        )
      : reqStart;
    move({
      run: run.id,
      kind: "request",
      from: run.via ?? run.caller,
      to: root,
      start: out,
      end: t,
      label: scheduled
        ? `scheduled run · ${name(root)}`
        : `request · ${name(root)}`,
      detail: `${name(run.caller)} runs the ${verb} ${name(root)}.`,
      cargo: run.carriesIn,
      tone: "normal",
      derived: run.carriesIn[0]?.derived,
    });
    // Where the recording shows what the caller stores, its storage says what
    // it holds; only derived cargo moves the holdings here.
    for (const c of run.carriesIn.filter((x) => x.derived))
      tl.holdings.push({
        at: reqStart,
        holder: run.caller,
        cargo: c,
        op: "drop",
      });
    beat(
      reqStart,
      t,
      run.id,
      run.carriesIn.length
        ? `${name(sender)} calls ${name(root)} with ${run.carriesIn.map((c) => c.label).join(", ")}`
        : `${name(sender)} calls ${name(root)}`,
      "normal",
      root,
      [run.caller, root],
    );

    const rootStart = t;
    const open: { target: string; arrived: number }[] = [];
    const stepsAt: number[] = [];
    for (const s of run.steps) {
      stepsAt.push(t);
      const caller = open.length ? open[open.length - 1].target : root;
      switch (s.kind) {
        case "call": {
          move({
            run: run.id,
            kind: "call",
            from: caller,
            to: s.target,
            start: t,
            end: t + P.call,
            label: `${s.callKind ?? "call"} · ${name(s.target)}`,
            detail: `${name(caller)} calls ${name(s.target)}${s.callKind ? ` (a ${s.callKind})` : ""}.${run.type === "Mutation" ? " Inside a mutation, it runs in the same transaction." : ""}`,
            cargo: [],
            tone: "normal",
          });
          beat(
            t,
            t + P.call + P.inside,
            run.id,
            `calls ${name(s.target)}`,
            "normal",
            s.target,
            [caller, s.target],
          );
          open.push({ target: s.target, arrived: t + P.call });
          t += P.call + P.inside;
          break;
        }
        case "return": {
          // Close the matching call, and any left open inside it.
          let call = open.pop();
          while (call && call.target !== s.target && open.length)
            call = open.pop();
          const back = open.length ? open[open.length - 1].target : root;
          if (call)
            tl.activations.push({
              node: call.target,
              run: run.id,
              start: call.arrived,
              end: t + 0.15,
              tone: s.tone,
            });
          move({
            run: run.id,
            kind: "return",
            from: s.target,
            to: back,
            start: t,
            end: t + P.return,
            label: `returns · ${name(s.target)}`,
            detail: `${name(s.target)} returns to ${name(back)}. The recording does not hold the value.`,
            cargo: [],
            tone: s.tone,
          });
          beat(
            t,
            t + P.return,
            run.id,
            `${name(s.target)} returns`,
            s.tone,
            back,
            [s.target, back],
          );
          t += P.return;
          break;
        }
        case "note": {
          beat(t, t + P.note, run.id, s.text, s.tone, caller);
          t += P.note;
          break;
        }
        case "log": {
          tl.alerts.push({
            start: t,
            end: t + P.log + P.return + P.commit + P.response,
            run: run.id,
            part: s.part,
            level: s.level,
            text: s.message,
          });
          beat(
            t,
            t + P.log,
            run.id,
            `${s.level.toLowerCase()} · ${s.message}`,
            s.tone,
            s.part,
          );
          t += P.log;
          break;
        }
      }
    }
    // Calls the reports left open close here.
    for (const call of open.reverse())
      tl.activations.push({
        node: call.target,
        run: run.id,
        start: call.arrived,
        end: t,
        tone: "normal",
      });

    // Commit: every write of the run lands at once.
    const commitAt = t;
    const tables = [...new Set(run.writes.map((w) => w.table))];
    for (const w of run.writes)
      tl.rowChanges.push({
        at: commitAt + P.commit * 0.6,
        run: run.id,
        write: w,
      });
    for (const table of tables) {
      const n = run.writes.filter((w) => w.table === table);
      const derived = n.find((w) => w.derived)?.derived;
      move({
        run: run.id,
        kind: "write",
        from: root,
        to: table,
        start: commitAt,
        end: commitAt + P.commit * 0.6,
        label: `${n.map((w) => w.op).join(", ")} · ${name(table)}`,
        detail: `The commit writes ${n.length} row${n.length === 1 ? "" : "s"} of ${name(table)}.`,
        cargo: [],
        tone: n.some((w) => w.op === "delete") ? "warn" : "normal",
        derived,
      });
    }
    if (run.writes.length) {
      beat(
        t,
        t + P.commit,
        run.id,
        `commit · ${run.writes.length} write${run.writes.length === 1 ? "" : "s"} to ${tables.map(name).join(", ")}`,
        "normal",
        tables.length === 1 ? tables[0] : root,
        [root, ...tables],
      );
      t += P.commit;
    }
    tl.activations.push({
      node: root,
      run: run.id,
      start: rootStart,
      end: t,
      tone: run.tone,
    });

    // The response, back to the caller.
    let answerAt: number | undefined;
    if (!scheduled) {
      const resStart = t;
      answerAt = resStart;
      t += (quick ? P.quick : P.response) + leg;
      const back = run.via ? t - (leg || (t - resStart) * 0.35) : t;
      if (run.via) calls.set(run.id, { run, out, back, home: t });
      if (run.via)
        hop(run, run.via, run.sender?.part ?? run.caller, back, "response", t);
      move({
        run: run.id,
        kind: "response",
        from: root,
        to: run.via ?? run.caller,
        start: resStart,
        end: back,
        label: `response · ${run.status}`,
        detail: run.carriesOut.length
          ? `The result goes back to ${name(run.caller)} with ${run.carriesOut.map((c) => c.label).join(", ")}.`
          : `The result goes back to ${name(run.caller)}: ${run.status}${run.error ? ` (${run.error})` : ""}.`,
        cargo: run.carriesOut,
        tone: run.tone,
        derived: run.carriesOut[0]?.derived,
      });
      for (const c of run.carriesOut.filter((x) => x.derived))
        tl.holdings.push({ at: t, holder: run.caller, cargo: c, op: "gain" });
      beat(
        resStart,
        t,
        run.id,
        run.carriesOut.length
          ? `${name(run.caller)} receives ${run.status} with ${run.carriesOut.map((c) => c.label).join(", ")}`
          : `${name(run.caller)} receives ${run.status}${run.error ? ` · ${run.error}` : ""}`,
        run.tone,
        run.caller,
        [root, run.caller],
      );
    }

    tl.chapters.push({
      run,
      title: `${name(root)}${run.status !== "ok" ? ` · ${run.status}` : ""}`,
      section: run.section,
      start,
      end: t,
      commitAt,
      stepsAt,
      ...(answerAt !== undefined ? { answerAt } : {}),
    });
  }
  tl.chapters.sort((a, b) => a.start - b.start);

  // A scheduled run's request leaves the run that scheduled it, at its commit.
  for (const c of tl.chapters) {
    const by = c.run.scheduledBy;
    if (!by) continue;
    const parent = tl.chapters.find((p) => p.run.id === by.run);
    if (!parent) continue;
    move({
      run: parent.run.id,
      kind: "schedule",
      from: parent.run.function,
      to: c.run.caller,
      start: parent.commitAt,
      end: parent.commitAt + PACE.schedule,
      label: `schedules · ${name(c.run.function)}`,
      detail: `The commit schedules ${name(c.run.function)}; ${name(c.run.caller)} runs it next.`,
      cargo: [],
      tone: "normal",
      derived: by.derived,
    });
  }

  tl.ops = operations(
    placed.all.flatMap((p) =>
      p.kind === "item" ? [{ item: p.item, at: placed.at.get(p)! }] : [],
    ),
    recording.runs,
    calls,
    brackets,
    placed.briefOps,
  );

  // The end is after every effect has ended, so that the world rests
  // there: a halo fading, a sweep around a page that loaded, a pulse out
  // of a state that changed or a key that was emptied.
  tl.duration = Math.max(
    placed.last,
    ...tl.chapters.map((c) => c.end),
    ...tl.movements.map((m) => m.end),
    ...tl.activations.map((a) => a.end),
    ...tl.clientSteps.map((c) => c.end + STEP_FADE),
    ...tl.loads.map((l) => l.at + LOAD_SWEEP),
    ...tl.states.map((c) => c.at + STATE_PULSE),
    ...tl.holdings
      .filter((h) => h.op === "drop")
      .map((h) => h.at + STATE_PULSE),
  );
  tl.items.sort((a, b) => a.at - b.at);
  tl.beats.sort((a, b) => a.start - b.start);
  tl.rowChanges.sort((a, b) => a.at - b.at);
  tl.movements.sort((a, b) => a.start - b.start);
  return tl;
}

/** The fields of a write's document, for a row card. */
export type { Doc };
