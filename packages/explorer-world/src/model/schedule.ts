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
import type {
  Cargo,
  Derivation,
  Doc,
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
}

/** Seconds of playback for each kind of step. */
export const PACE = {
  lead: 0.8,
  request: 1.8,
  call: 1.2,
  inside: 0.5,
  return: 1.0,
  note: 1.6,
  page: 1.1,
  log: 2.6,
  commit: 1.6,
  response: 1.8,
  schedule: 1.2,
  gap: 1.4,
};

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
  };
  const name = (id: string) => index.part.get(id)?.label ?? id;
  let movementCount = 0;
  const move = (m: Omit<Movement, "id">) =>
    tl.movements.push({ ...m, id: `m${++movementCount}` });
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

  /** What a page did outside the runs: beats at the page, and what it holds. */
  const playItems = (run: Run, items: Run["before"], from: number) => {
    let at = from;
    for (const it of items) {
      beat(
        at,
        at + PACE.page,
        run.id,
        `${name(it.part)}: ${it.text}`,
        it.tone,
        it.part,
      );
      if (it.hold)
        tl.holdings.push({
          at: at + PACE.page * 0.5,
          holder: it.part,
          cargo: it.hold.cargo,
          op: it.hold.op,
        });
      at += PACE.page;
    }
    return at;
  };

  let t = 0;
  for (const run of recording.runs) {
    const start = t;
    const root = run.function;
    // A run that shows nothing inside (a query read again) passes quickly.
    const quick = !run.steps.length && !run.writes.length;
    const pace = quick ? 0.5 : 1;
    t = playItems(run, run.before, t);
    t += PACE.lead * pace;
    const scheduled = Boolean(run.scheduledBy);
    const verb = run.type.toLowerCase();

    // The request, from the caller.
    const reqStart = t;
    t += (scheduled ? PACE.schedule : PACE.request) * pace;
    move({
      run: run.id,
      kind: "request",
      from: run.caller,
      to: root,
      start: reqStart,
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
        ? `${name(run.caller)} calls ${name(root)} with ${run.carriesIn.map((c) => c.label).join(", ")}`
        : `${name(run.caller)} calls ${name(root)}`,
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
            end: t + PACE.call,
            label: `${s.callKind ?? "call"} · ${name(s.target)}`,
            detail: `${name(caller)} calls ${name(s.target)}${s.callKind ? ` (a ${s.callKind})` : ""}.${run.type === "Mutation" ? " Inside a mutation, it runs in the same transaction." : ""}`,
            cargo: [],
            tone: "normal",
          });
          beat(
            t,
            t + PACE.call + PACE.inside,
            run.id,
            `calls ${name(s.target)}`,
            "normal",
            s.target,
            [caller, s.target],
          );
          open.push({ target: s.target, arrived: t + PACE.call });
          t += PACE.call + PACE.inside;
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
            end: t + PACE.return,
            label: `returns · ${name(s.target)}`,
            detail: `${name(s.target)} returns to ${name(back)}. The recording does not hold the value.`,
            cargo: [],
            tone: s.tone,
          });
          beat(
            t,
            t + PACE.return,
            run.id,
            `${name(s.target)} returns`,
            s.tone,
            back,
            [s.target, back],
          );
          t += PACE.return;
          break;
        }
        case "note": {
          beat(t, t + PACE.note, run.id, s.text, s.tone, caller);
          t += PACE.note;
          break;
        }
        case "log": {
          tl.alerts.push({
            start: t,
            end: t + PACE.log + PACE.return + PACE.commit + PACE.response,
            run: run.id,
            part: s.part,
            level: s.level,
            text: s.message,
          });
          beat(
            t,
            t + PACE.log,
            run.id,
            `${s.level.toLowerCase()} · ${s.message}`,
            s.tone,
            s.part,
          );
          t += PACE.log;
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
        at: commitAt + PACE.commit * 0.6,
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
        end: commitAt + PACE.commit * 0.6,
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
        t + PACE.commit,
        run.id,
        `commit · ${run.writes.length} write${run.writes.length === 1 ? "" : "s"} to ${tables.map(name).join(", ")}`,
        "normal",
        tables.length === 1 ? tables[0] : root,
        [root, ...tables],
      );
      t += PACE.commit;
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
      t += PACE.response * pace;
      move({
        run: run.id,
        kind: "response",
        from: root,
        to: run.caller,
        start: resStart,
        end: t,
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

    t = playItems(run, run.after, t);
    tl.chapters.push({
      run,
      title: `${name(root)}${run.status !== "ok" ? ` · ${run.status}` : ""}`,
      section: run.section,
      start,
      end: t,
      commitAt,
    });
    t += PACE.gap * pace;
  }

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

  tl.duration = t;
  tl.beats.sort((a, b) => a.start - b.start);
  tl.rowChanges.sort((a, b) => a.at - b.at);
  tl.movements.sort((a, b) => a.start - b.start);
  return tl;
}

/** The fields of a write's document, for a row card. */
export type { Doc };
