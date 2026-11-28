/**
 * The play-by-play: one line per thing the running code reported, in the
 * order it happened, grouped the way it happened.
 *
 * Each pressed control is a section, and so is what the page did on open
 * before anything was pressed; what the client did by itself while nothing
 * was pressed (a token refreshed on its timer) is a faint section of its own.
 * In a section, each operation of the client is a block: a line for the
 * operation, then its steps; the call it made (matched by bracket, see
 * `operations.ts`) and the function run it reached sit inside it, with the
 * run's own steps and writes under the run. What belongs to no operation (an
 * input, a load, a change of a storage key, a run nobody's operation made)
 * is a line of its own, in time order between the blocks.
 *
 * The words come from the presentation (`phrases`): a project's phrase per
 * step and per kind of operation, the generic words of the preset for what
 * every project has. A step with no phrase shows its code name alone. A line
 * never holds a value: names of functions, tables, keys and fields, labels
 * of what was carried, flags and codes, as the recording holds them.
 *
 * @module
 */
import type { Phrase, Phrases, Presentation } from "../presentation.ts";
import type { OpPath } from "./operations.ts";
import type { PageItem, PageState, Run, Tone } from "./recording.ts";
import type { Chapter, Timeline } from "./schedule.ts";
import type { GraphIndex } from "./graph.ts";

/** What a line marks in the world, as the world selects it. */
export type PlayTarget =
  | { type: "op"; id: string }
  | { type: "run"; id: string }
  | { type: "part"; id: string }
  | { type: "row"; table: string; id: string };

/**
 * The kind of mark a line carries: the same thing the viewer sees in the
 * world for it.
 */
export type Mark =
  | "press"
  | "open"
  | "unasked"
  | "op"
  | "step"
  | "input"
  | "page"
  | "send"
  | "run"
  | "call"
  | "note"
  | "write"
  | "answer"
  | "key"
  | "state"
  | "rerun";

export interface PlayLine {
  id: string;
  /** When it happens, in shown time. */
  at: number;
  /** 1: a block or a line of its own; 2: inside a block; 3: inside a run. */
  depth: 1 | 2 | 3;
  /** Who did it, in a word or two. */
  who: string;
  /** What it did, in plain words. */
  text: string;
  /** The code name of what was reported (`session.set`), when it has one. */
  code?: string;
  mark: Mark;
  tone: Tone;
  /** For a mark coloured by its operation: the operation. */
  op?: string;
  /** For a mark coloured by a sign-in state: the state. */
  state?: PageState;
  /** What it marks in the world when clicked. */
  target?: PlayTarget;
  /** The parts it is about, for marking its lines from the world. */
  parts: string[];
  /** The block it is in: an operation, a run, or itself. */
  block: string;
  /** For a line of what ran inside a function (its steps, its writes): the run. */
  inRun?: string;
  section: string;
}

export interface PlaySection {
  id: string;
  kind: "open" | "press" | "unasked";
  title: string;
  /** When it starts and ends, in shown time. */
  at: number;
  end: number;
  lines: PlayLine[];
}

/** Fills `{field}` in a text from `values`; a field with no value is dropped. */
export function fill(
  text: string,
  values: Record<string, unknown> | undefined,
): string {
  return text
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = values?.[k];
      return v === undefined || v === null || typeof v === "object"
        ? ""
        : String(v);
    })
    .replace(/\s+([,.:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The text of a phrase for a detail: the first variant whose `when` holds. */
export function phraseText(
  phrase: Phrase | undefined,
  detail: Record<string, unknown> | undefined,
): string | null {
  if (phrase === undefined) return null;
  if (typeof phrase === "string") return phrase;
  const hit = phrase.find((v) =>
    Object.entries(v.when ?? {}).every(([k, want]) => detail?.[k] === want),
  );
  return hit?.text ?? null;
}

/** A step's phrase, filled, or null when the project gives none. */
export function stepPhrase(
  phrases: Phrases | undefined,
  step: string,
  detail: Record<string, unknown> | undefined,
): string | null {
  const text = phraseText(phrases?.steps?.[step], detail);
  return text === null ? null : fill(text, detail);
}

/** An error code from a fixed list (capitals and underscores), never a message. */
const isCode = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(v);

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Everything the list needs of a world. */
export interface PlayInput {
  timeline: Timeline;
  index: GraphIndex;
  presentation: Presentation;
  /** The island a part stands on, for naming who ran on the backend. */
  islandOf?: (part: string) => string | null;
}

/** The play-by-play of a recording on its timeline. */
export function playByPlay(input: PlayInput): PlaySection[] {
  const { timeline: tl, index, presentation } = input;
  const phrases = presentation.phrases ?? {};
  const g = (key: string, values?: Record<string, unknown>) =>
    fill(phrases.generic?.[key] ?? key, values);
  const label = (id: string) => index.part.get(id)?.label ?? id;
  const short = (id: string) => {
    const p = index.part.get(id);
    return p?.name.split(/[/:.]/).pop() || p?.label || id;
  };
  const who = (id: string) => phrases.who?.[id] ?? label(id);
  const islandWho = (id: string) => {
    const island = input.islandOf?.(id);
    if (!island) return g("backend");
    const kind = index.part.get(island)?.kind;
    return (
      phrases.who?.[island] ??
      (kind && phrases.generic?.[`island.${kind}`]) ??
      label(island)
    );
  };

  // The sections: what was pressed, what came before, and what nobody asked for.
  const spans: { at: number; end: number; title: string }[] = [];
  let open: { at: number; title: string } | null = null;
  for (const { at, item } of tl.items) {
    if (item.scenario === "start") {
      if (open) spans.push({ ...open, end: at });
      open = { at, title: item.pressed ?? item.text };
    } else if (item.scenario === "end" && open) {
      spans.push({ ...open, end: at });
      open = null;
    }
  }
  if (open) spans.push({ ...open, end: Infinity });

  /** The section a time falls in. */
  const sections: PlaySection[] = [];
  const sectionAt = (at: number, acts: boolean): PlaySection => {
    const span = spans.find((s) => at >= s.at - 1e-6 && at < s.end + 0.05);
    const kind = span
      ? "press"
      : spans.some((s) => s.at <= at)
        ? "unasked"
        : "open";
    const last = sections.at(-1);
    // What nobody asked for starts with something the code did by itself
    // (an operation, a call); a change of storage or a load that comes
    // after a press is the press's.
    if (kind === "unasked" && !acts && last) return last;
    if (span) {
      const id = `press@${span.at.toFixed(3)}`;
      if (last?.id === id) return last;
      const found = sections.find((s) => s.id === id);
      if (found) return found;
      const made: PlaySection = {
        id,
        kind: "press",
        title: capital(span.title),
        at: span.at,
        end: span.end,
        lines: [],
      };
      sections.push(made);
      return made;
    }
    // Consecutive things nobody asked for are one section.
    if (last && last.kind === kind) return last;
    const made: PlaySection = {
      id: `${kind}@${at.toFixed(3)}`,
      kind,
      title: kind === "open" ? g("open") : g("unasked"),
      at,
      end: at,
      lines: [],
    };
    sections.push(made);
    return made;
  };

  // Every line, before it is put in its section and block.
  type Entry = { line: Omit<PlayLine, "section">; order: number };
  const entries: Entry[] = [];
  let order = 0;
  const add = (line: Omit<PlayLine, "section">) =>
    entries.push({ line, order: order++ });

  const opOf = new Map(tl.ops.map((o) => [o.id, o]));
  const opOfRun = new Map<string, OpPath>();
  for (const o of tl.ops) if (o.run) opOfRun.set(o.run, o);
  const opStarted = new Set<string>();

  // What the pages did: steps, inputs, loads, storage, unlinked calls.
  for (const { at, item } of tl.items) {
    if (item.scenario) continue;
    const id = `i${order}`;
    const op = item.op ? opOf.get(item.op) : undefined;
    const block = op?.id ?? id;
    if (op && !opStarted.has(op.id)) {
      opStarted.add(op.id);
      add({
        id: `op:${op.id}`,
        at,
        depth: 1,
        who: who(item.part),
        text: phrases.ops?.[op.kind] ?? op.kind,
        code: op.kind,
        mark: "op",
        tone: op.tone,
        op: op.id,
        target: { type: "op", id: op.id },
        parts: [item.part],
        block,
      });
    }
    add(itemLine(item, at, id, op ? 2 : 1, block));
  }

  function itemLine(
    item: PageItem,
    at: number,
    id: string,
    depth: 1 | 2,
    block: string,
  ): Omit<PlayLine, "section"> {
    const base = { id, at, depth, block, tone: item.tone };
    if (item.step) {
      const detail = {
        ...item.report?.detail,
        ...(item.state ? { state: g(`state.${item.state.state}`) } : {}),
      };
      const text = stepPhrase(phrases, item.step, detail);
      const key = item.lights?.[1];
      return {
        ...base,
        who: who(item.part),
        text: text ?? "",
        code: item.step + (item.code ? ` · ${item.code}` : ""),
        mark: item.state ? "state" : key ? "key" : "step",
        ...(item.state ? { state: item.state.state } : {}),
        ...(item.op ? { op: item.op } : {}),
        target: item.op
          ? { type: "op", id: item.op }
          : { type: "part", id: item.part },
        parts: item.lights ?? [item.part],
      };
    }
    if (item.hold) {
      const what = item.hold.cargo.noun ?? item.hold.cargo.label;
      return {
        ...base,
        who: label(item.part),
        text: g(item.hold.op === "gain" ? "holds" : "drops", { what }),
        mark: "key",
        target: { type: "part", id: item.part },
        parts: [item.part],
      };
    }
    if (item.input)
      return {
        ...base,
        who: g("page"),
        text: g(`input.${item.input.action}`, { what: item.input.what }),
        mark: "input",
        target: { type: "part", id: item.part },
        parts: [item.part],
      };
    if (item.kind === "storage")
      return {
        ...base,
        who: label(item.part),
        text: g("storage"),
        mark: "key",
        target: { type: "part", id: item.part },
        parts: [item.part],
      };
    if (item.kind === "console")
      return {
        ...base,
        who: g("page"),
        text: g("console", {
          level: item.tone === "error" ? "error" : "warning",
        }),
        mark: "page",
        parts: [item.part],
      };
    if (item.kind === "call" && item.fn)
      return {
        ...base,
        who: g("page"),
        text: g("unlinked", {
          type: item.callType ?? "",
          function: item.fn,
        }),
        mark: "send",
        parts: [item.part],
      };
    return {
      ...base,
      who: g("page"),
      text: item.text,
      mark: "page",
      target: { type: "part", id: item.part },
      parts: [item.part],
    };
  }

  // The runs: their request, what ran, its steps, its writes, its answer.
  const reruns: Chapter[] = [];
  for (const c of tl.chapters) {
    const run = c.run;
    const op = opOfRun.get(run.id);
    const subscribed =
      run.type === "Query" &&
      !run.via &&
      !run.scheduledBy &&
      !run.writes.length;
    if (subscribed) {
      reruns.push(c);
      continue;
    }
    runLines(c, op);
  }
  // Queries run again for their subscribers: one faint line per run of them.
  for (let i = 0; i < reruns.length;) {
    let j = i + 1;
    while (j < reruns.length && reruns[j].start <= reruns[j - 1].end + 0.5) j++;
    const group = reruns.slice(i, j);
    const fns = [...new Set(group.map((c) => c.run.function))];
    add({
      id: `rerun:${group[0].run.id}`,
      at: group[0].start,
      depth: 1,
      who: g("backend"),
      text: g("rerun", { functions: fns.map(short).join(", ") }),
      code: "query",
      mark: "rerun",
      tone: "normal",
      target: { type: "run", id: group[0].run.id },
      parts: fns,
      block: `rerun:${group[0].run.id}`,
    });
    i = j;
  }

  function runLines(c: Chapter, op: OpPath | undefined) {
    const run = c.run;
    const block = op?.id ?? `run:${run.id}`;
    const d = op ? 2 : 1;
    const inner = (op ? 3 : 2) as 2 | 3;
    const fn = short(run.function);
    const type = run.type.toLowerCase();
    const parts = [run.function, ...(run.via ? [run.via] : [])];
    // The request.
    if (run.scheduledBy)
      add({
        id: `run:${run.id}`,
        at: c.start,
        depth: d,
        who: g("scheduler"),
        text: g("scheduled", { function: fn }),
        code: type,
        mark: "run",
        tone: run.tone,
        target: { type: "run", id: run.id },
        parts,
        block,
      });
    else
      add({
        id: `send:${run.id}`,
        at: c.start,
        depth: d,
        who: run.via ? label(run.via) : label(run.caller),
        text:
          g("send", { type, function: fn }) +
          (loadsOf(run, "in") ? `, ${loadsOf(run, "in")}` : ""),
        mark: "send",
        tone: "normal",
        target: { type: "run", id: run.id },
        parts: [run.caller, ...parts],
        block,
      });
    // What ran.
    if (!run.scheduledBy)
      add({
        id: `run:${run.id}`,
        at: c.start + 0.01,
        depth: inner === 3 ? 2 : d,
        who: islandWho(run.function),
        // A query's run lasts while it is subscribed: no time of its own.
        text:
          run.type === "Query"
            ? g("run.query", { function: fn })
            : g("run", {
                function: fn,
                ms: Math.max(1, Math.round(run.endedAt - run.startedAt)),
              }),
        code: type,
        mark: "run",
        tone: run.tone,
        target: { type: "run", id: run.id },
        parts: [run.function],
        block,
      });
    const depth = (inner === 3 ? 3 : 2) as 2 | 3;
    run.steps.forEach((s, i) => {
      const at = c.stepsAt[i] ?? c.start;
      const id = `${run.id}#s${i}`;
      if (s.kind === "call") {
        add({
          id,
          at,
          depth,
          who: islandWho(s.target),
          text:
            stepPhrase(phrases, "call", { target: short(s.target) }) ??
            g("call", { target: short(s.target) }),
          code: "call",
          mark: "call",
          tone: "normal",
          target: { type: "part", id: s.target },
          parts: [s.target],
          block,
          inRun: run.id,
        });
      } else if (s.kind === "note") {
        const text = stepPhrase(phrases, s.name, s.detail);
        const code = isCode(s.detail.error) ? s.detail.error : undefined;
        add({
          id,
          at,
          depth,
          who: islandWho(run.function),
          text: text ?? "",
          code: s.name + (code ? ` · ${code}` : ""),
          mark: "note",
          tone: s.tone,
          target: { type: "run", id: run.id },
          parts: [run.function],
          block,
          inRun: run.id,
        });
      } else if (s.kind === "log") {
        add({
          id,
          at,
          depth,
          who: islandWho(s.part),
          text: g("log", { level: s.level.toLowerCase() }),
          mark: "note",
          tone: s.tone,
          target: { type: "part", id: s.part },
          parts: [s.part],
          block,
          inRun: run.id,
        });
      }
      // A return is not a line: the call's line says where it went, and the
      // next line says what came after.
    });
    // The writes, at the commit: one line per island, its tables named.
    const byIsland = new Map<string, Run["writes"]>();
    for (const w of run.writes) {
      const key = input.islandOf?.(w.table) ?? w.table;
      byIsland.set(key, [...(byIsland.get(key) ?? []), w]);
    }
    for (const [island, ws] of byIsland) {
      const tables = (op: string) =>
        [...new Set(ws.filter((w) => w.op === op).map((w) => w.table))]
          .map(short)
          .join(", ");
      const written = [
        ...new Set(ws.filter((w) => w.op !== "delete").map((w) => w.table)),
      ]
        .map(short)
        .join(", ");
      const deleted = tables("delete");
      // When its rows land in their tables, as the world shows them.
      const lands = tl.rowChanges.find(
        (r) => r.run === run.id && ws.includes(r.write),
      )?.at;
      add({
        id: `${run.id}#w:${island}`,
        at: lands ?? c.commitAt,
        depth,
        who: islandWho(ws[0].table),
        text: [
          written && g("write", { tables: written }),
          deleted && g("write.delete", { tables: deleted }),
        ]
          .filter(Boolean)
          .join(", "),
        code: [...new Set(ws.map((w) => w.op))].join(", "),
        mark: "write",
        tone: deleted ? "warn" : "normal",
        target: { type: "row", table: ws[0].table, id: ws[0].row },
        parts: [...new Set(ws.map((w) => w.table))],
        block,
        inRun: run.id,
      });
    }
    // The answer.
    if (c.answerAt !== undefined) {
      const code = run.steps
        .map((s) => (s.kind === "note" ? s.detail.error : undefined))
        .find(isCode);
      const refused = run.tone === "error" || !run.ok;
      add({
        id: `answer:${run.id}`,
        at: c.answerAt,
        depth: d,
        who: run.via ? label(run.via) : label(run.caller),
        text: refused
          ? g("refused", { function: fn })
          : g("answer", { function: fn }) +
            (loadsOf(run, "out") ? `, ${loadsOf(run, "out")}` : ""),
        code: refused ? (code ?? run.status) : undefined,
        mark: "answer",
        tone: refused ? "error" : "normal",
        target: { type: "run", id: run.id },
        parts: [run.caller, ...parts],
        block,
      });
    }
  }

  /** What a request or a response carried, by label: never a value. */
  function loadsOf(run: Run, dir: "in" | "out"): string {
    const loads = dir === "in" ? run.loadIn : run.loadOut;
    if (loads?.length)
      return g("carrying", {
        what: loads
          .map((l) =>
            l.kind === "blanked"
              ? g("blanked", { field: l.field })
              : (l.cargo?.noun ?? l.field),
          )
          .join(", "),
      });
    const cargo = dir === "in" ? run.carriesIn : run.carriesOut;
    return cargo.length
      ? g("carrying", { what: cargo.map((c) => c.noun ?? c.label).join(", ") })
      : "";
  }

  // In order: blocks at their first line, lines of a block together, in the
  // order they happened.
  entries.sort((a, b) => a.line.at - b.line.at || a.order - b.order);
  const firstOf = new Map<string, number>();
  const firstOrder = new Map<string, number>();
  for (const e of entries)
    if (!firstOf.has(e.line.block)) {
      firstOf.set(e.line.block, e.line.at);
      firstOrder.set(e.line.block, e.order);
    }
  entries.sort(
    (a, b) =>
      firstOf.get(a.line.block)! - firstOf.get(b.line.block)! ||
      firstOrder.get(a.line.block)! - firstOrder.get(b.line.block)! ||
      a.line.at - b.line.at ||
      a.order - b.order,
  );
  const sectionOf = new Map<string, PlaySection>();
  for (const e of entries) {
    let section = sectionOf.get(e.line.block);
    if (!section) {
      section = sectionAt(
        firstOf.get(e.line.block)!,
        ["op", "send", "run", "rerun"].includes(e.line.mark),
      );
      sectionOf.set(e.line.block, section);
    }
    section.lines.push({ ...e.line, section: section.id });
    section.end = Math.max(section.end, e.line.at);
  }
  for (const s of sections) {
    if (s.kind !== "unasked") continue;
    // A faint section says what was done in it, by the operations' words.
    const kinds = [
      ...new Set(s.lines.filter((l) => l.mark === "op").map((l) => l.text)),
    ];
    if (kinds.length) s.title = `${g("unasked")}: ${kinds.join("; ")}`;
  }
  sections.sort((a, b) => a.at - b.at);
  return sections.map((s) =>
    s.end === Infinity ? { ...s, end: s.lines.at(-1)?.at ?? s.at } : s,
  );
}

/** Every line of the list, in the order it reads. */
export const allLines = (sections: PlaySection[]) =>
  sections.flatMap((s) => s.lines);

/**
 * The line being played at time `t`: the latest line, in time, that has
 * happened. Null before the first.
 */
export function lineAt(sections: PlaySection[], t: number): PlayLine | null {
  let best: PlayLine | null = null;
  for (const l of allLines(sections))
    if (l.at <= t + 1e-6 && (!best || l.at >= best.at)) best = l;
  return best;
}

/** The times of the lines, in increasing order, each once. */
export function lineTimes(sections: PlaySection[]): number[] {
  return [...new Set(allLines(sections).map((l) => l.at))].sort(
    (a, b) => a - b,
  );
}

const cache = new WeakMap<Timeline, PlaySection[]>();

/**
 * The play-by-play of a world, computed once per timeline: the island a
 * part stands on is the nearest of its enclosing parts the layout made an
 * island.
 */
export function playByPlayOf(world: {
  timeline: Timeline;
  index: GraphIndex;
  presentation: Presentation;
  layout: { islands: { id: string }[] };
}): PlaySection[] {
  let sections = cache.get(world.timeline);
  if (!sections) {
    const islands = new Set(world.layout.islands.map((i) => i.id));
    const islandOf = (id: string) => {
      let p = world.index.part.get(id);
      while (p && !islands.has(p.id))
        p = p.parent ? world.index.part.get(p.parent) : undefined;
      return p?.id ?? null;
    };
    sections = playByPlay({ ...world, islandOf });
    cache.set(world.timeline, sections);
  }
  return sections;
}

/**
 * The next or previous moment to step to from time `t`: the next line
 * that happens, or the one before the line being played. Null when there
 * is none that way.
 */
export function lineStop(
  sections: PlaySection[],
  t: number,
  direction: 1 | -1,
): number | null {
  const times = lineTimes(sections);
  if (direction === 1) return times.find((x) => x > t + 1e-3) ?? null;
  return times.filter((x) => x < t - 1e-3).at(-1) ?? null;
}
