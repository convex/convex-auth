/**
 * Maps a timeline of the explorer recorder (`@convex-dev/explorer`, NDJSON) to
 * the recording of the world, and joins every name in it to a part of the
 * graph. Generic for any Convex project; what is specific to a project (how a
 * step report reads, which rows travel) comes from the presentation.
 *
 * It reads the event kinds it knows (`recording`, `run`, `log`, `step`,
 * `write`) and counts the others: add a reader to `READERS` to play a new kind.
 *
 * Join rules (until the structure package exports its own):
 * - a run of component `c`, `module:fn` → `fn:c:module.fn`; of the app →
 *   `fn:app:<app>:module.fn`;
 * - a step's call target `a/b/c` → `fn:a:b.c`, trying each split of the path
 *   into a component path and a module path;
 * - a write → `table:c.table`, or `table:app:<app>.table`.
 */
import type { Graph, GraphIndex, Part } from "../model/graph.ts";
import { indexGraph } from "../model/graph.ts";
import type {
  Cargo,
  Doc,
  Recording,
  Run,
  Step,
  Tone,
  Unplaced,
  Write,
} from "../model/recording.ts";
import { fill, type Presentation } from "../presentation.ts";
import { exitOf } from "./browserPlaces.ts";
import { PAGE_KINDS, readPageFeed } from "./convexPage.ts";

interface RunEvent {
  kind: "run";
  id: string;
  time: number;
  endTime: number;
  udfType: string;
  componentPath: string;
  identifier: string;
  caller: string;
  requestId: string;
  parentExecutionId: string | null;
  ok: boolean;
  error: string | null;
  cachedResult: boolean;
  writeCount: number;
  readCount: number;
  identityType: string | null;
}
interface LogEvent {
  kind: "log";
  id: string;
  time: number;
  runId: string;
  level: string;
  componentPath: string;
  udfPath: string;
  message: string;
}
interface StepEvent {
  kind: "step";
  id: string;
  time: number;
  runId: string;
  source: string | null;
  step: string;
  detail: Record<string, unknown>;
}
interface WriteEvent {
  kind: "write";
  id: string;
  time: number;
  ts: string;
  component: string;
  table: string;
  documentId: string;
  deleted: boolean;
  value: Record<string, unknown> | null;
  runId: string | null;
  snapshot: boolean;
}
/** One event of a recorder timeline, as parsed from its NDJSON. */
export type Event = { kind: string; time?: number } & Record<string, unknown>;

export function parseNdjson(text: string): Event[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Event);
}

/** Write tolerance: how far from a run's end a write may commit to be its own. */
const COMMIT_WINDOW_MS = 250;

export interface RecordingResult {
  recording: Recording;
  /** Parts the recording shows that the structure map does not have. */
  observed: Part[];
}

const sequence = (id: string) => Number(id.split("#").pop() ?? 0);

/** Maps the names of a recording to part ids, as `joinRecording` of the structure package does. */
export interface Join {
  run(run: { componentPath: string | null; identifier: string }): string | null;
  callTarget(target: string): string | null;
  table(write: { component: string | null; table: string }): string | null;
}

/**
 * Builds the recording. `graph` is the structure; the result's `observed`
 * parts must be added to it (see `withObserved`). `join` makes the structure
 * package's join for the app the recording ran in; where it finds nothing,
 * the rules at the top of this module apply.
 */
export function recordingFromTimeline(
  events: Event[],
  graph: Graph,
  presentation: Presentation,
  join?: (app: string) => Join | null,
): RecordingResult {
  const index = indexGraph(graph);
  const observed = new Map<string, Part>();
  const unplaced: Unplaced[] = [];
  const counts: Recording["events"] = {};
  const count = (kind: string, played: boolean) => {
    counts[kind] ??= { seen: 0, played: 0 };
    counts[kind].seen++;
    if (played) counts[kind].played++;
  };
  const has = (id: string) => index.part.has(id) || observed.has(id);

  const app = focusApp(events, index, presentation);
  const appPart = app ? `app:${app}` : null;
  let joined: Join | null = null;
  try {
    joined = app && join ? join(app) : null;
  } catch {
    joined = null;
  }

  const observe = (part: Part) => {
    if (!has(part.id)) observed.set(part.id, part);
    return part.id;
  };

  const fnId = (componentPath: string, module: string, name: string) =>
    componentPath
      ? `fn:${componentPath}:${module}.${name}`
      : `fn:app:${app ?? "?"}:${module}.${name}`;

  /** A function of a component or the app, from `module:fn` or `module.js:fn`. */
  const resolveFunction = (componentPath: string, identifier: string) => {
    const found = joined?.run({ componentPath, identifier });
    if (found) return found;
    const [rawModule, name] = identifier.split(":");
    const module = rawModule.replace(/\.js$/, "");
    const id = fnId(componentPath, module, name ?? "default");
    if (has(id)) return id;
    const owner = componentPath ? `component:${componentPath}` : appPart;
    return observe({
      id,
      kind: "function",
      name: name ?? identifier,
      label: name ?? identifier,
      parent: owner && has(owner) ? owner : null,
      source: null,
      facts: [["module", module]],
      observed:
        "The recording runs this function; the structure map does not list it.",
    });
  };

  /** A call target `component/path/module/fn`. */
  const resolveTarget = (target: string) => {
    const found = joined?.callTarget(target);
    if (found) return found;
    const segs = target.split("/");
    for (let i = segs.length - 2; i >= 1; i--) {
      const id = fnId(
        segs.slice(0, i).join("/"),
        segs.slice(i, -1).join("/"),
        segs[segs.length - 1],
      );
      if (has(id)) return id;
    }
    return resolveFunction(
      segs[0],
      `${segs.slice(1, -1).join("/")}:${segs[segs.length - 1]}`,
    );
  };

  const resolveTable = (component: string, table: string) => {
    const found = joined?.table({ component, table });
    if (found) return found;
    const id = component
      ? `table:${component}.${table}`
      : `table:app:${app ?? "?"}.${table}`;
    if (has(id)) return id;
    const owner = component ? `component:${component}` : appPart;
    return observe({
      id,
      kind: "table",
      name: table,
      label: table,
      parent: owner && has(owner) ? owner : null,
      source: null,
      facts: [],
      observed:
        "The recording writes this table; the structure map does not list it (the tables of a component from npm are not in the map yet).",
    });
  };

  const resolveCaller = (caller: string) => {
    const look = presentation.callers?.[caller];
    return observe({
      id: `caller:${caller}`,
      kind: "caller",
      name: caller,
      label: look?.label ?? caller,
      parent: null,
      source: null,
      facts: look?.summary ? [["summary", look.summary]] : [],
      observed: "A caller the recording names.",
    });
  };

  // Sort the feeds out.
  let startedAt = 0;
  const runEvents: RunEvent[] = [];
  const byRun = new Map<string, (LogEvent | StepEvent)[]>();
  const writeEvents: WriteEvent[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "recording":
        startedAt = Number(e.time);
        count(e.kind, true);
        break;
      case "run":
        runEvents.push(e as unknown as RunEvent);
        break;
      case "log":
      case "step": {
        // A step the page reported (the client library) has no run: the
        // browser feed reads it below.
        if (e.kind === "step" && e.from === "page") break;
        const ev = e as unknown as LogEvent | StepEvent;
        byRun.set(ev.runId, [...(byRun.get(ev.runId) ?? []), ev]);
        break;
      }
      case "write":
        writeEvents.push(e as unknown as WriteEvent);
        break;
      default:
        // The browser feed is read below; anything else is counted, not played.
        if (!PAGE_KINDS.has(e.kind)) count(e.kind, false);
    }
  }
  for (const [kind, n] of Object.entries(counts)) {
    if (counts[kind].played === 0)
      unplaced.push({
        what: `${n.seen} event${n.seen === 1 ? "" : "s"} of kind "${kind}"`,
        reason: "The world has no reader for this kind of event yet.",
      });
  }
  runEvents.sort((a, b) => a.time - b.time);

  // Writes, in commit order, with the operation each one is.
  writeEvents.sort((a, b) =>
    BigInt(a.ts) < BigInt(b.ts) ? -1 : BigInt(a.ts) > BigInt(b.ts) ? 1 : 0,
  );
  const lastValue = new Map<string, Doc>();
  const snapshot: Write[] = [];
  const writesByRun = new Map<string, Write[]>();
  for (const w of writeEvents) {
    const table = resolveTable(w.component, w.table);
    const key = `${table}/${w.documentId}`;
    const before = lastValue.get(key);
    const doc = (w.value ?? {}) as Doc;
    const write: Write = {
      table,
      row: w.documentId,
      op: w.deleted ? "delete" : before ? "update" : "insert",
      doc,
      changed: w.deleted
        ? []
        : Object.keys(doc).filter(
            (k) =>
              !before || JSON.stringify(before[k]) !== JSON.stringify(doc[k]),
          ),
      time: w.time,
    };
    if (w.deleted) lastValue.delete(key);
    else lastValue.set(key, doc);
    if (w.snapshot) {
      count("write", true);
      snapshot.push(write);
      continue;
    }
    let runId = w.runId;
    if (!runId) {
      const owner = nearestRun(runEvents, w.time);
      if (owner) {
        runId = owner.run.id;
        write.derived = {
          rule: "write-by-commit-time",
          note: `The recording does not link this write to a run. It is given to the run that ended nearest its commit time (${owner.gap.toFixed(1)} ms apart).`,
        };
      }
    }
    if (!runId || !runEvents.some((r) => r.id === runId)) {
      count("write", false);
      unplaced.push({
        what: `a ${write.op} of ${w.component ? `${w.component}.` : ""}${w.table} ${w.documentId}`,
        reason: "No run of the recording wrote it.",
      });
      continue;
    }
    count("write", true);
    writesByRun.set(runId, [...(writesByRun.get(runId) ?? []), write]);
  }

  const runs: Run[] = runEvents.map((r) => {
    count("run", true);
    const fn = resolveFunction(r.componentPath, r.identifier);
    const steps: Step[] = [];
    let status = r.ok ? "ok" : "error";
    let tone: Tone = r.ok ? "normal" : "error";
    const worse = (t: Tone) => {
      if (t === "error" || (t === "warn" && tone === "normal")) tone = t;
    };
    const feed = (byRun.get(r.id) ?? []).sort(
      (a, b) => sequence(a.id) - sequence(b.id),
    );
    for (const e of feed) {
      if (e.kind === "log") {
        count("log", true);
        const level = e.level.toUpperCase();
        const t: Tone =
          level === "ERROR" ? "error" : level === "WARN" ? "warn" : "normal";
        worse(t);
        steps.push({
          kind: "log",
          level,
          part: e.udfPath ? resolveFunction(e.componentPath, e.udfPath) : fn,
          message: e.message,
          tone: t,
        });
        continue;
      }
      count("step", true);
      if (e.step === "call" && typeof e.detail.target === "string") {
        steps.push({
          kind: "call",
          target: resolveTarget(e.detail.target),
          callKind:
            typeof e.detail.kind === "string" ? e.detail.kind : undefined,
        });
      } else if (e.step === "return" && typeof e.detail.target === "string") {
        steps.push({
          kind: "return",
          target: resolveTarget(e.detail.target),
          tone: "normal",
        });
      } else {
        const look = presentation.steps?.[e.step];
        const t: Tone = look?.toneBy
          ? (look.toneBy.tones[String(e.detail[look.toneBy.field])] ?? "normal")
          : "normal";
        worse(t);
        if (look?.statusField && e.detail[look.statusField] !== undefined)
          status = String(e.detail[look.statusField]);
        steps.push({
          kind: "note",
          name: e.step,
          text: look?.text
            ? fill(look.text, e.detail)
            : `${e.step}${
                Object.keys(e.detail).length
                  ? ` · ${Object.entries(e.detail)
                      .map(([k, v]) => `${k} ${String(v)}`)
                      .join(", ")}`
                  : ""
              }`,
          tone: t,
          detail: e.detail,
        });
      }
    }
    if (!r.ok) status = "error";
    return {
      id: r.id,
      function: fn,
      caller: resolveCaller(r.caller),
      startedAt: r.time,
      endedAt: r.endTime,
      type: r.udfType,
      ok: r.ok,
      error: r.error,
      status,
      tone,
      steps,
      writes: writesByRun.get(r.id) ?? [],
      carriesIn: [],
      carriesOut: [],
      before: [],
      after: [],
      facts: [
        ["execution id", r.id],
        ["request id", r.requestId],
        ["component", r.componentPath || "(app)"],
        ["function", r.identifier],
        ["type", r.udfType],
        ["caller", r.caller],
        ["identity", r.identityType ?? "none"],
        ["documents read", String(r.readCount)],
        ["documents written", String(r.writeCount)],
        ...(r.cachedResult ? [["cached", "yes"] as [string, string]] : []),
      ],
    };
  });

  // Which run scheduled each scheduled run.
  const full = indexGraph({
    ...graph,
    parts: [...graph.parts, ...observed.values()],
  });
  runs.forEach((run, i) => {
    const event = runEvents[i];
    if (event.parentExecutionId) {
      run.scheduledBy = { run: event.parentExecutionId };
      return;
    }
    if (event.caller !== "Scheduler") return;
    for (let j = i - 1; j >= 0; j--) {
      const earlier = runs[j];
      const touched = [
        earlier.function,
        ...earlier.steps.flatMap((s) => (s.kind === "call" ? [s.target] : [])),
      ];
      const schedules = touched.some((f) =>
        (full.out.get(f) ?? []).some(
          (l) => l.kind === "schedules" && l.to === run.function,
        ),
      );
      if (schedules) {
        run.scheduledBy = {
          run: earlier.id,
          derived: {
            rule: "scheduled-by-structure",
            note: "The recording does not say which run scheduled this one. It is the latest earlier run that reached a function the structure map shows scheduling it.",
          },
        };
        return;
      }
    }
  });

  // The browser feed: the page becomes the caller of the runs it called,
  // carries the secrets its messages held, and its own doings play between runs.
  const page = readPageFeed(
    events as never,
    presentation,
    resolveTable,
    new Set(runs.map((r) => r.id)),
    has,
  );
  for (const p of page.pages) observe(p);
  for (const [kind, c] of Object.entries(page.counts)) {
    counts[kind] = c;
    if (c.played < c.seen)
      unplaced.push({
        what: `${c.seen - c.played} of ${c.seen} "${kind}" events`,
        reason: page.unplayed[kind] ?? "Nothing in the world shows them.",
      });
  }
  for (const run of runs) {
    const call = page.calls.get(run.id);
    if (call) {
      run.caller = call.page;
      if (has(exitOf(call.transport))) run.via = exitOf(call.transport);
      if (call.sender)
        run.sender = {
          part: call.sender,
          derived: {
            rule: "sender-by-bracket",
            note: "The recording does not link the call to the module. It is the only call of this function the page made between the module's signIn.call and signIn.return, in the order the recorder numbered the page's events.",
          },
        };
      run.sentAt = call.sentAt;
      run.order = call.order;
      run.answeredAt = call.answeredAt;
      run.carriesIn = call.cargoIn;
      run.carriesOut = call.cargoOut;
      run.loadIn = call.loadIn;
      run.loadOut = call.loadOut;
      run.facts.push([
        "page call",
        `${call.transport}, linked by ${call.link}`,
      ]);
    }
    run.section = [...page.sections]
      .reverse()
      .find((s) => s.time <= run.startedAt)?.text;
  }
  // What the page did plays after the run before it. Against a run the page
  // called, that is decided by the page's own order of events (the backend's
  // clock and the page's differ by milliseconds); against any other, by time.
  const before = (r: Run, it: (typeof page.items)[number]) => {
    const asked = page.calls.get(r.id)?.order;
    return asked && it.order && asked.page === it.order.page
      ? asked.seq < it.order.seq
      : r.startedAt <= it.time;
  };
  const early: (typeof page.items)[number][] = [];
  for (const it of page.items) {
    const owner = [...runs].reverse().find((r) => before(r, it));
    if (owner) owner.after.push(it);
    else if (runs[0]) runs[0].before.push(it);
    else early.push(it);
  }
  const fromData = page.counts.secret?.seen > 0;

  // Rows that travel with requests and responses, where the recording does
  // not show them: derived by the presentation's rules.
  for (const rule of fromData ? [] : (presentation.cargo ?? [])) {
    for (const run of runs) {
      if (run.scheduledBy) continue;
      const mine = run.writes.filter((w) => w.table === rule.table);
      const label = (row: string) => `${rule.noun} …${row.slice(-4)}`;
      if (rule.out === "inserted") {
        for (const w of mine.filter((w) => w.op === "insert")) {
          run.carriesOut.push(
            cargo(rule.table, w.row, label(w.row), {
              rule: "cargo-out-inserted",
              note: `The recording does not record return values. The response is shown carrying the ${rule.noun} this run inserted (row ${w.row}).`,
            }),
          );
        }
      }
      if (rule.in) {
        const { field, from } = rule.in;
        for (const w of mine.filter((w) => w.op === "update")) {
          const before = previousDoc(runs, run, w, snapshot);
          if (before?.[field] === from && w.doc[field] !== from) {
            run.carriesIn.push(
              cargo(rule.table, w.row, label(w.row), {
                rule: "cargo-in-updated",
                note: `The recording does not record arguments. The request is shown carrying the ${rule.noun} this run moved from ${field} "${from}" to "${String(w.doc[field])}" (row ${w.row}).`,
              }),
            );
          }
        }
      }
    }
  }

  return {
    recording: {
      startedAt: startedAt || (runs[0]?.startedAt ?? 0),
      app: app ?? undefined,
      runs,
      ...(early.length ? { early } : {}),
      snapshot,
      unplaced,
      events: counts,
    },
    observed: [...observed.values()],
  };
}

function cargo(
  table: string,
  row: string,
  label: string,
  derived: Cargo["derived"],
): Cargo {
  return { table, row, label, derived };
}

/** The document a write changed, as it was before it. */
function previousDoc(
  runs: Run[],
  run: Run,
  write: Write,
  snapshot: Write[],
): Doc | undefined {
  let doc: Doc | undefined;
  const all = [...snapshot, ...runs.flatMap((r) => r.writes)].sort(
    (a, b) => a.time - b.time,
  );
  for (const w of all) {
    if (w === write) break;
    if (w.table === write.table && w.row === write.row) doc = w.doc;
  }
  void run;
  return doc;
}

function nearestRun(
  runs: RunEvent[],
  time: number,
): { run: RunEvent; gap: number } | null {
  let best: { run: RunEvent; gap: number } | null = null;
  for (const run of runs) {
    if (run.udfType === "Query") continue;
    const gap =
      time < run.time
        ? run.time - time
        : time > run.endTime
          ? time - run.endTime
          : 0;
    if (gap <= COMMIT_WINDOW_MS && (!best || gap < best.gap))
      best = { run, gap };
  }
  return best;
}

/**
 * The app the recording ran in: the one its `recording` event names, else
 * the presentation's `focus`, else the app whose functions the app's runs
 * name most often.
 */
function focusApp(
  events: Event[],
  index: GraphIndex,
  presentation: Presentation,
): string | null {
  const named = events.find((e) => e.kind === "recording")?.app;
  if (typeof named === "string" && index.part.has(`app:${named}`)) return named;
  const focus = presentation.focus;
  if (focus?.startsWith("app:")) return focus.slice(4);
  const scores = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "run" || e.componentPath) continue;
    const [module, name] = String(e.identifier).split(":");
    for (const p of index.graph.parts) {
      if (p.kind !== "app") continue;
      const id = `fn:${p.id}:${module.replace(/\.js$/, "")}.${name}`;
      if (index.part.has(id)) scores.set(p.name, (scores.get(p.name) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  for (const [name, n] of scores)
    if (!best || n > (scores.get(best) ?? 0)) best = name;
  return best;
}

/** The graph with the parts the recording showed added. */
export function withObserved(graph: Graph, observed: Part[]): Graph {
  return { ...graph, parts: [...graph.parts, ...observed] };
}
