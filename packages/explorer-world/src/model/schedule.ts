/**
 * Lays the recording out on a timeline at human speed.
 *
 * A recorded run takes milliseconds; a person needs seconds to follow it. The
 * schedule keeps the order of the recording and its causality (a call returns
 * before the next one starts, writes commit at the end of their function run)
 * and gives each step a duration a person can watch.
 */
import type {
  Doc,
  Execution,
  Recording,
  Step,
  Structure,
  TokenRef,
} from "./types.ts";

/** Fixed places of the platform that things travel to. */
export const GATE = "platform:gate";
export const SIGNER = "platform:signer";
export const SCHEDULER = "platform:scheduler";

/** A region id, a function id, or one of the places above. */
export type Anchor = string;

export type Tone = "normal" | "warn" | "error";

export interface Movement {
  id: string;
  execution: string;
  kind: "request" | "response" | "call" | "return" | "sign" | "schedule";
  from: Anchor;
  to: Anchor;
  /** A place the movement passes through on its way. */
  via?: Anchor;
  start: number;
  end: number;
  label: string;
  detail: string;
  tokens: TokenRef[];
  tone: Tone;
}

export interface Activation {
  node: string;
  execution: string;
  start: number;
  end: number;
  tone: Tone;
}

export interface RowChange {
  at: number;
  execution: string;
  table: string;
  row: string;
  op: "insert" | "patch" | "delete";
  label?: string;
  doc: Doc;
}

export interface HoldingChange {
  at: number;
  holder: string;
  token: TokenRef;
  op: "gain" | "drop";
}

export interface Beat {
  start: number;
  end: number;
  execution: string;
  text: string;
  tone: Tone;
  /** The node the beat is about, for the camera to follow. */
  focus?: Anchor;
}

export interface Alert {
  start: number;
  end: number;
  execution: string;
  region: string;
  text: string;
}

export interface Chapter {
  execution: Execution;
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
  start: 0.9,
  call: 1.2,
  inside: 0.5,
  return: 1.0,
  sign: 0.7,
  log: 2.6,
  result: 0.8,
  commit: 1.6,
  response: 1.8,
  schedule: 1.2,
  gap: 1.4,
};

function shortName(structure: Structure, id: string): string {
  const fn = structure.functions.find((f) => f.id === id);
  if (!fn) return id;
  const region = structure.regions.find((r) => r.id === fn.region);
  return region && region.kind === "component"
    ? `${region.label}.${fn.name.replace(/^public\./, "")}`
    : fn.name;
}

export function buildTimeline(
  structure: Structure,
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
  let t = 0;
  let movementCount = 0;
  const name = (id: string) => shortName(structure, id);

  const move = (m: Omit<Movement, "id">) => {
    tl.movements.push({ ...m, id: `m${++movementCount}` });
  };
  const beat = (
    start: number,
    end: number,
    execution: string,
    text: string,
    tone: Tone = "normal",
    focus?: Anchor,
  ) => tl.beats.push({ start, end, execution, text, tone, focus });

  for (const ex of recording.executions) {
    const start = t;
    const root = ex.function;
    const tone: Tone =
      ex.status === "error"
        ? "error"
        : ex.status === "noSession"
          ? "warn"
          : "normal";
    t += PACE.lead;

    // A replayed token: the other holder shows up holding its copy.
    if (ex.presents && ex.caller !== "browser") {
      tl.holdings.push({
        at: start,
        holder: ex.caller,
        token: ex.presents,
        op: "gain",
      });
    }

    // The request. From a client it passes the platform's token check.
    const reqStart = t;
    t += ex.scheduled ? PACE.schedule : PACE.request;
    move({
      execution: ex.id,
      kind: "request",
      from: ex.scheduled ? SCHEDULER : ex.caller,
      to: root,
      via: ex.scheduled ? undefined : GATE,
      start: reqStart,
      end: t,
      label: ex.scheduled ? "scheduled run" : `request · ${name(root)}`,
      detail: ex.scheduled
        ? `The scheduler starts ${name(root)}.`
        : `The client calls ${name(root)}. The platform checks the caller's access token before the function runs.`,
      tokens: ex.presents ? [ex.presents] : [],
      tone: "normal",
    });
    beat(
      reqStart,
      t,
      ex.id,
      ex.scheduled
        ? `The scheduler runs ${name(root)}`
        : ex.presents
          ? `${regionLabel(structure, ex.caller)} presents refresh token ${ex.presents.label} to ${name(root)}`
          : `${regionLabel(structure, ex.caller)} calls ${name(root)}`,
      "normal",
      root,
    );

    const rootStart = t;
    // Calls in flight, innermost last.
    const open: { target: string; arrived: number }[] = [];
    for (const s of ex.steps) {
      t = scheduleStep(s, ex, t);
    }

    function scheduleStep(s: Step, ex: Execution, t: number): number {
      const caller = open.length ? open[open.length - 1].target : root;
      switch (s.kind) {
        case "start":
          beat(
            t,
            t + PACE.start,
            ex.id,
            `${name(root)} starts the ${methodLabel(ex)} method`,
            "normal",
            root,
          );
          return t + PACE.start;
        case "call": {
          move({
            execution: ex.id,
            kind: "call",
            from: caller,
            to: s.target,
            start: t,
            end: t + PACE.call,
            label: `call · ${name(s.target)}`,
            detail: `${name(caller)} calls ${name(s.target)}. A component call runs in the same transaction as its caller.`,
            tokens: [],
            tone: "normal",
          });
          beat(
            t,
            t + PACE.call + PACE.inside,
            ex.id,
            `calls ${name(s.target)}`,
            "normal",
            s.target,
          );
          open.push({ target: s.target, arrived: t + PACE.call });
          return t + PACE.call + PACE.inside;
        }
        case "return": {
          const call = open.pop();
          const back = open.length ? open[open.length - 1].target : root;
          const rTone: Tone = /INVALID|error/i.test(s.value ?? "")
            ? "error"
            : /no session/i.test(s.value ?? "")
              ? "warn"
              : "normal";
          if (call) {
            tl.activations.push({
              node: call.target,
              execution: ex.id,
              start: call.arrived,
              end: t + 0.15,
              tone: rTone,
            });
          }
          move({
            execution: ex.id,
            kind: "return",
            from: s.target,
            to: back,
            start: t,
            end: t + PACE.return,
            label: `returns · ${s.value ?? "ok"}`,
            detail: `${name(s.target)} returns${s.value ? `: ${s.value}` : ""}.`,
            tokens: [],
            tone: rTone,
          });
          beat(
            t,
            t + PACE.return,
            ex.id,
            `${name(s.target)} returns${s.value ? ` — ${s.value}` : ""}`,
            rTone,
            back,
          );
          return t + PACE.return;
        }
        case "sessionIssued": {
          const half = PACE.sign;
          move({
            execution: ex.id,
            kind: "sign",
            from: root,
            to: SIGNER,
            start: t,
            end: t + half,
            label: "claims",
            detail:
              "The session's claims go to be signed with the deployment's key.",
            tokens: [],
            tone: "normal",
          });
          const issued = ex.tokens.find((k) => k.kind === "access");
          move({
            execution: ex.id,
            kind: "sign",
            from: SIGNER,
            to: root,
            start: t + half,
            end: t + 2 * half,
            label: `signed · ${issued?.label ?? "access token"}`,
            detail: "A signed access token (a JWT) for the new session.",
            tokens: issued ? [issued] : [],
            tone: "normal",
          });
          beat(
            t,
            t + 2 * half,
            ex.id,
            "session issued — the platform signs an access token",
            "normal",
            SIGNER,
          );
          return t + 2 * half;
        }
        case "log": {
          tl.alerts.push({
            start: t,
            end: t + PACE.log + PACE.return + PACE.commit + PACE.response,
            execution: ex.id,
            region: s.region,
            text: s.message,
          });
          beat(
            t,
            t + PACE.log,
            ex.id,
            `warning · ${s.message}`,
            "warn",
            s.region,
          );
          return t + PACE.log;
        }
        case "result": {
          const rTone: Tone =
            s.status === "error"
              ? "error"
              : s.status === "noSession"
                ? "warn"
                : "normal";
          beat(
            t,
            t + PACE.result,
            ex.id,
            `result · ${s.status}${s.error ? ` (${s.error})` : ""}`,
            rTone,
            root,
          );
          return t + PACE.result;
        }
      }
    }

    // Commit: every write of the run lands at once.
    const commitAt = t;
    for (const w of ex.writes) {
      tl.rowChanges.push({
        at: commitAt,
        execution: ex.id,
        table: w.table,
        row: w.row,
        op: w.op,
        label: w.label,
        doc: w.doc,
      });
    }
    if (ex.writes.length) {
      beat(
        t,
        t + PACE.commit,
        ex.id,
        `commit · ${ex.writes.length} write${ex.writes.length === 1 ? "" : "s"} land together`,
        "normal",
        ex.writes.length === 1 ? ex.writes[0].table : undefined,
      );
      t += PACE.commit;
    }
    tl.activations.push({
      node: root,
      execution: ex.id,
      start: rootStart,
      end: t,
      tone,
    });

    // The response, carrying the new tokens to the client.
    if (!ex.scheduled) {
      const resStart = t;
      t += PACE.response;
      move({
        execution: ex.id,
        kind: "response",
        from: root,
        to: ex.caller,
        start: resStart,
        end: t,
        label: `response · ${ex.status ?? "ok"}`,
        detail: ex.tokens.length
          ? `The result goes back to the client with ${ex.tokens.map((k) => k.label).join(" and ")}.`
          : `The result goes back to the client: ${ex.status}${ex.error ? ` (${ex.error})` : ""}.`,
        tokens: ex.tokens,
        tone,
      });
      for (const token of ex.tokens) {
        tl.holdings.push({ at: t, holder: ex.caller, token, op: "gain" });
      }
      if (ex.status === "noSession" && ex.presents) {
        tl.holdings.push({
          at: t,
          holder: ex.caller,
          token: ex.presents,
          op: "drop",
        });
      }
      beat(
        resStart,
        t,
        ex.id,
        ex.tokens.length
          ? `${regionLabel(structure, ex.caller)} receives ${ex.tokens.map((k) => k.label).join(" + ")}`
          : `${regionLabel(structure, ex.caller)} receives ${ex.status}${ex.error ? ` · ${ex.error}` : ""}`,
        tone,
        ex.caller,
      );
    }

    for (const fn of ex.schedules) {
      move({
        execution: ex.id,
        kind: "schedule",
        from: root,
        to: SCHEDULER,
        start: commitAt,
        end: commitAt + PACE.schedule,
        label: `schedules · ${name(fn)}`,
        detail: `The commit schedules ${name(fn)} to run right after.`,
        tokens: [],
        tone: "normal",
      });
    }

    tl.chapters.push({ execution: ex, start, end: t, commitAt });
    t += PACE.gap;
  }
  tl.duration = t;
  tl.beats.sort((a, b) => a.start - b.start);
  return tl;
}

function regionLabel(structure: Structure, id: string): string {
  return structure.regions.find((r) => r.id === id)?.label ?? id;
}

function methodLabel(ex: Execution): string {
  return /Username|username/.test(ex.function)
    ? "username + password"
    : "sign-in";
}
