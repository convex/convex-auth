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
import { operations, type CallSpan, type OpPath } from "./operations.ts";
import type {
  Cargo,
  Derivation,
  Doc,
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
}

export interface Timeline {
  duration: number;
  chapters: Chapter[];
  beats: Beat[];
  movements: Movement[];
  activations: Activation[];
  rowChanges: RowChange[];
  holdings: HoldingChange[];
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
}

/**
 * Seconds of shown time for the parts of a function run. A run takes
 * milliseconds; these make each part long enough to see, and no longer.
 */
export const PACE = {
  request: 0.35,
  call: 0.16,
  inside: 0.06,
  return: 0.14,
  note: 0.2,
  log: 0.5,
  commit: 0.35,
  response: 0.35,
  schedule: 0.4,
  /** A run that shows nothing inside (a query read again): out and back. */
  quick: 0.3,
};

/** Seconds a step the client reported, or another page event, stays lit. */
export const LIT = 0.5;

/**
 * The least shown time between two consecutive things that happened, in
 * seconds: a step of the same operation as the one before it, another
 * page event, a run starting.
 */
export const GAP = { sameOp: 0.08, item: 0.12, run: 0.08, lead: 0.6 };

/** The shown length of a query run again with nothing new to show. */
export const RERUN = 0.7;

/** A real gap up to this (s) is shown as it is. */
const REAL_UP_TO = 0.5;
/** No real gap is shown longer than this (s): a long wait is a short pause. */
export const LONGEST_WAIT = 2.4;

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
    REAL_UP_TO + 0.45 * Math.log(1 + (real - REAL_UP_TO) / REAL_UP_TO),
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
  return rerun.has(run.id) && n > RERUN ? RERUN / n : 1;
}

type Placed =
  | { kind: "item"; real: number; item: Run["before"][number]; run: Run }
  | { kind: "run"; real: number; run: Run };

/**
 * Where each run and each page event goes in shown time. Everything is
 * taken in real order; each is at least a short gap after the one before
 * it, and a real gap longer than that is shown as {@link shownGap} of it.
 * A run lasts {@link naturalLength} (a query run again, {@link RERUN}); what the page did while it was in flight
 * plays while it plays, and what happened after its answer waits for it.
 * Thus things that happened at the same time play at the same time, and
 * shown time is one increasing function of real time.
 */
function place(recording: Recording, rerun: Set<string>) {
  const all: Placed[] = [];
  for (const run of recording.runs) {
    for (const item of run.before)
      all.push({ kind: "item", real: item.time, item, run });
    all.push({ kind: "run", real: run.sentAt ?? run.startedAt, run });
    for (const item of run.after)
      all.push({ kind: "item", real: item.time, item, run });
  }
  // A page's own order of events wins over its times, which the recorder
  // takes as the events reach it: along each page's order, an event is
  // taken no earlier than the one before it.
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
      p.real = Math.max(p.real, floor);
      floor = p.real;
    }
  }
  // In that order; ties keep the adapter's order (the sort is stable).
  all.sort((a, b) => a.real - b.real);
  const at = new Map<Placed, number>();
  const runStart = new Map<string, number>();
  const warp: Warp = { real: [], shown: [] };
  const open: { answer: number; end: number }[] = [];
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
    at.set(p, s);
    if (p.kind === "run") {
      runStart.set(p.run.id, s);
      const end = s + naturalLength(p.run) * runScale(p.run, rerun);
      open.push({ answer: p.run.answeredAt ?? p.run.endedAt, end });
      last = Math.max(last, end);
    } else last = Math.max(last, s + LIT);
    if (!warp.real.length || p.real > warp.real[warp.real.length - 1]) {
      warp.real.push(p.real);
      warp.shown.push(s);
    }
    prev = p;
    prevShown = s;
  }
  return { all, at, runStart, warp, last };
}

export function buildTimeline(
  index: GraphIndex,
  recording: Recording,
): Timeline {
  const tl: Timeline = {
    duration: 0,
    chapters: [],
    beats: [],
    movements: [],
    activations: [],
    rowChanges: [],
    holdings: [],
    alerts: [],
    states: [],
    clientSteps: [],
    warp: { real: [], shown: [] },
    actions: [],
    actionEnds: [],
    ops: [],
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
  const playItem = (run: Run, it: Run["before"][number], at: number) => {
    const end = at + LIT;
    beat(
      at,
      end,
      run.id,
      `${name(it.part)}: ${it.text}`,
      it.tone,
      it.part,
      it.lights ?? [it.part],
    );
    for (const node of it.lights ?? [])
      tl.activations.push({ node, run: run.id, start: at, end, tone: it.tone });
    if (it.step)
      tl.clientSteps.push({
        start: at,
        end,
        part: it.part,
        step: it.step,
        tone: it.tone,
      });
    if (it.state)
      tl.states.push({
        at: at + 0.05,
        holder: it.state.holder,
        state: it.state.state,
      });
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
  const placed = place(recording, rerun);
  // Where each call that left by a way out of the browser is, for the
  // operations that made them.
  const calls = new Map<string, CallSpan>();
  tl.warp = placed.warp;
  for (const p of placed.all)
    if (p.kind === "item") {
      playItem(p.run, p.item, placed.at.get(p)!);
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
    t += quick ? P.quick : scheduled ? P.schedule : P.request;
    const sender = run.sender?.part ?? run.caller;
    const out = run.via
      ? hop(
          run,
          sender,
          run.via,
          reqStart,
          "request",
          reqStart + (t - reqStart) * 0.35,
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
    for (const s of run.steps) {
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
    if (!scheduled) {
      const resStart = t;
      t += quick ? P.quick : P.response;
      const back = run.via ? t - (t - resStart) * 0.35 : t;
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
  );

  tl.duration = Math.max(
    placed.last,
    ...tl.chapters.map((c) => c.end),
    ...tl.movements.map((m) => m.end),
  );
  tl.beats.sort((a, b) => a.start - b.start);
  tl.rowChanges.sort((a, b) => a.at - b.at);
  tl.movements.sort((a, b) => a.start - b.start);
  return tl;
}

/** The fields of a write's document, for a row card. */
export type { Doc };
