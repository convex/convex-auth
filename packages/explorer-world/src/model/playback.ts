/**
 * The state of the world at a time of the timeline. Pure: the same time always
 * gives the same world, so scrubbing backwards is as cheap as playing forward.
 */
import type { Cargo, Doc } from "./recording.ts";
import type {
  Activation,
  Alert,
  Beat,
  Chapter,
  Movement,
  Timeline,
  Tone,
} from "./schedule.ts";

/** How long a deleted row stays visible while it dissolves, in seconds. */
export const DELETE_FADE = 2.4;

export interface RowState {
  id: string;
  doc: Doc;
  /** The value of the table's state field, if it has one. */
  state?: string;
  /** Position among the table's rows, by insertion. */
  slot: number;
  insertedAt: number;
  changedAt: number;
  changedFields: string[];
  /** When the row was deleted; it is shown dissolving for DELETE_FADE. */
  deletedAt?: number;
  history: {
    at: number;
    op: string;
    run: string;
    doc: Doc;
    derived?: string;
  }[];
}

export interface Traveller {
  movement: Movement;
  /** 0 at the start of the movement, 1 at its end. */
  progress: number;
}

export interface WorldState {
  time: number;
  chapter: Chapter | null;
  chapterIndex: number;
  beat: Beat | null;
  travellers: Traveller[];
  active: Map<string, { run: string; since: number; tone: Tone }>;
  tables: Map<string, RowState[]>;
  holdings: Map<string, Cargo[]>;
  alerts: Alert[];
}

export function clampTime(timeline: Timeline, t: number): number {
  return Math.min(Math.max(t, 0), timeline.duration);
}

export function stateAt(
  timeline: Timeline,
  rawTime: number,
  stateFields: Map<string, string> = new Map(),
): WorldState {
  const time = clampTime(timeline, rawTime);

  let chapterIndex = -1;
  timeline.chapters.forEach((c, i) => {
    if (c.start <= time) chapterIndex = i;
  });
  const chapter = chapterIndex >= 0 ? timeline.chapters[chapterIndex] : null;

  let beat: Beat | null = null;
  for (const b of timeline.beats) {
    if (b.start <= time) beat = b;
    else break;
  }

  const travellers: Traveller[] = timeline.movements
    .filter((m) => m.start <= time && time < m.end)
    .map((m) => ({
      movement: m,
      progress: (time - m.start) / (m.end - m.start),
    }));

  const active = new Map<string, { run: string; since: number; tone: Tone }>();
  for (const a of timeline.activations as Activation[]) {
    if (a.start <= time && time < a.end) {
      active.set(a.node, {
        run: a.run,
        since: a.start,
        tone: a.tone,
      });
    }
  }

  const tables = new Map<string, RowState[]>();
  const rows = new Map<string, RowState>();
  const slots = new Map<string, number>();
  for (const c of timeline.rowChanges) {
    if (c.at > time) break;
    const w = c.write;
    const key = `${w.table}/${w.row}`;
    const existing = rows.get(key);
    const stateField = stateFields.get(w.table);
    const entry = {
      at: c.at,
      op: w.op,
      run: c.run,
      doc: w.doc,
      derived: w.derived?.note,
    };
    if (w.op === "insert" || !existing) {
      const slot = slots.get(w.table) ?? 0;
      slots.set(w.table, slot + 1);
      const row: RowState = {
        id: w.row,
        doc: { ...w.doc },
        slot,
        insertedAt: c.at,
        changedAt: c.at,
        changedFields: Object.keys(w.doc),
        history: [entry],
      };
      if (stateField) row.state = String(w.doc[stateField] ?? "");
      rows.set(key, row);
      const list = tables.get(w.table) ?? [];
      list.push(row);
      tables.set(w.table, list);
      if (w.op === "delete") row.deletedAt = c.at;
      continue;
    }
    existing.history.push(entry);
    existing.changedAt = c.at;
    if (w.op === "delete") {
      existing.deletedAt = c.at;
      existing.changedFields = [];
    } else {
      existing.doc = { ...w.doc };
      existing.changedFields = w.changed;
      if (stateField && stateField in w.doc) {
        existing.state = String(w.doc[stateField]);
      }
    }
  }
  // Rows deleted long enough ago are gone.
  for (const [table, list] of tables) {
    tables.set(
      table,
      list.filter(
        (r) => r.deletedAt === undefined || time - r.deletedAt < DELETE_FADE,
      ),
    );
  }

  const holdings = new Map<string, Cargo[]>();
  for (const h of timeline.holdings) {
    if (h.at > time) continue;
    const held = (holdings.get(h.holder) ?? []).filter(
      (k) => !(k.table === h.cargo.table && k.row === h.cargo.row),
    );
    if (h.op === "gain") held.push(h.cargo);
    holdings.set(h.holder, held);
  }

  const alerts = timeline.alerts.filter((a) => a.start <= time && time < a.end);

  return {
    time,
    chapter,
    chapterIndex,
    beat,
    travellers,
    active,
    tables,
    holdings,
    alerts,
  };
}

/** The start of the next beat after `t`, for stepping forward. */
export function nextStop(timeline: Timeline, t: number): number {
  const next = timeline.beats.find((b) => b.start > t + 1e-6);
  return next ? next.start : timeline.duration;
}

/** The start of the beat before the one at `t`, for stepping back. */
export function previousStop(timeline: Timeline, t: number): number {
  let previous = 0;
  for (const b of timeline.beats) {
    if (b.start < t - 1e-6) previous = b.start;
    else break;
  }
  return previous;
}
