/**
 * The card a click opens, beside what was clicked. It answers two questions
 * and no more: what is this (its name, its kind, the group it is in, and one
 * line in the source's own words, when the source has one), and what has it
 * done so far in this session (from the recording only; nothing when it has
 * done nothing). Everything else, the links in the source included, waits
 * behind "All of it" (key I), which opens the full panel.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { doneBy } from "../model/done.ts";
import { layInside } from "../model/insideLayout.ts";
import { done, insideOf } from "../insides.ts";
import { groupFacts, groupName } from "../scene/Groups.tsx";
import { highlightOf } from "../scene/highlight.ts";
import { cardAt } from "../scene/CardAnchor.tsx";
import { nounOfPart, partOf, placementOf } from "../scene/look.ts";
import { TONE_COLORS } from "../scene/palette.ts";
import { loadName } from "../model/operations.ts";
import type { WorldState } from "../model/playback.ts";
import { currentState, usePlayback, world, type Selection } from "../store.ts";

const labelOf = (id: string) => partOf(id)?.label ?? id;
const chapterOf = (run: string) =>
  world.timeline.chapters.find((c) => c.run.id === run);
const times = (n: number) =>
  n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;

export interface CardContent {
  kind: string;
  title: string;
  /** The group it stands in, if any. */
  group?: string;
  /** One line from the source, and the export it is from when not the part's own. */
  line?: { text: string; from?: string };
  /** What it has done, or is doing now: a line or two, none when nothing. */
  doing: ReactNode[];
  /** Whether it has an inside to open up (`Inside.tsx`). */
  opens?: boolean;
}

function partCard(id: string, state: WorldState): CardContent {
  const part = partOf(id);
  const t = state.time;
  const inside = insideOf(id);
  const group = groupFacts().groupOf.get(id);
  const island = world.layout.islands.find((i) => i.id === id);
  const doing: ReactNode[] = [];

  const active = state.active.get(id);
  if (active)
    doing.push(
      <span className="live" key="now">
        {world.recording.runs.some((r) => r.function === id)
          ? "Running now"
          : "Acting now"}
        , in {chapterOf(active.run)?.title ?? "a run"}
      </span>,
    );
  // Steps it reported, at the places in its code that can report.
  const so = doneBy(done(), id, t);
  if (so.hits.length) {
    const sites = inside?.sites.length ?? 0;
    doing.push(
      <span key="steps">
        {sites
          ? `Reported ${so.count} of the ${sites} steps it can report`
          : `Reported ${times(so.hits.length)}`}
        {so.latest && (
          <>
            {" · latest "}
            <span className="mono">{so.latest.step}</span>
          </>
        )}
      </span>,
    );
  } else if (inside?.sites.length)
    doing.push(
      <span key="steps" className="dim">
        Can report {inside.sites.length} step
        {inside.sites.length === 1 ? "" : "s"}; none yet
      </span>,
    );
  // Runs of it, and calls to it.
  // A run counts once it is over; one under way is running now.
  const mine = world.timeline.chapters.filter((c) => c.run.function === id);
  const ran = mine.filter((c) => c.end <= t);
  const under = mine.find((c) => c.start <= t && t < c.end);
  if (under && !active)
    doing.push(
      <span className="live" key="now">
        Running now
      </span>,
    );
  if (ran.length) {
    const last = ran[ran.length - 1].run;
    doing.push(
      <span key="ran">
        Ran {times(ran.length)} · last{" "}
        {last.error ? (
          <span style={{ color: TONE_COLORS.error }}>{last.status}</span>
        ) : (
          last.status
        )}
      </span>,
    );
  }
  const called = world.timeline.movements.filter(
    (m) => m.kind === "call" && m.to === id && m.start <= t,
  ).length;
  if (called) doing.push(<span key="called">Called {times(called)}</span>);
  // A table's rows, a holder's holdings.
  const rows = state.tables.get(id);
  if (rows?.length) {
    const now = rows.filter((r) => r.deletedAt === undefined).length;
    doing.push(
      <span key="rows">
        {now} row{now === 1 ? "" : "s"} now
      </span>,
    );
  }
  const held = state.holdings.get(id);
  if (held?.length)
    doing.push(
      <span key="held">Holds {held.map((c) => c.label).join(", ")}</span>,
    );
  // An island or a group: how many of its parts took part.
  const members = island?.members ?? [];
  if (members.length) {
    const took = members.filter(
      (m) => (groupFacts().parts.get(m) ?? Infinity) <= t,
    ).length;
    if (took)
      doing.push(
        <span key="took">
          {took} of its {members.length} parts took part
        </span>,
      );
  }

  return {
    kind: nounOfPart(id),
    title: part?.label ?? id,
    group: group && group.id !== id ? groupName(group) : undefined,
    line:
      inside?.summary ??
      (world.presentation.parts?.[id]?.summary
        ? { text: world.presentation.parts[id].summary! }
        : undefined),
    doing,
    opens: inside ? layInside(inside).places.length > 0 : false,
  };
}

/** What the card says of a selection, at the current time. */
export function cardOf(s: Selection, state: WorldState): CardContent {
  const t = state.time;
  switch (s.type) {
    case "part":
      return partCard(s.id, state);
    case "row": {
      const row = state.tables.get(s.table)?.find((r) => r.id === s.id);
      const last = row?.history[row.history.length - 1];
      return {
        kind: `row of ${labelOf(s.table)}`,
        title: `…${s.id.slice(-6)}`,
        doing: row
          ? [
              <span key="state">
                {row.deletedAt !== undefined ? "deleted" : (row.state ?? "")}
                {last?.run && (
                  <>
                    {row.state || row.deletedAt !== undefined ? " · " : ""}
                    {last.op} by {chapterOf(last.run)?.title ?? "a run"}
                  </>
                )}
              </span>,
            ]
          : [
              <span key="gone" className="dim">
                Does not exist at this moment
              </span>,
            ],
      };
    }
    case "cargo": {
      const held = state.holdings.get(s.holder)?.find((c) => c.row === s.row);
      return {
        kind: "held",
        title: held?.label ?? s.row,
        doing: [
          <span key="by">
            {held ? "Held by " : "Not held at this moment by "}
            {labelOf(s.holder)}
          </span>,
        ],
      };
    }
    case "movement": {
      const m = world.timeline.movements.find((x) => x.id === s.id);
      if (!m) return { kind: "movement", title: s.id, doing: [] };
      const when =
        t < m.start ? "not yet left" : t < m.end ? "on its way now" : "arrived";
      return {
        kind: m.kind,
        title: m.label,
        doing: [
          <span key="way">
            {labelOf(m.from)} → {labelOf(m.to)} · {when}
          </span>,
          ...(m.cargo.length
            ? [
                <span key="cargo">
                  Carries {m.cargo.map((c) => c.label).join(", ")}
                </span>,
              ]
            : []),
        ],
      };
    }
    case "run": {
      const c = chapterOf(s.id);
      if (!c) return { kind: "run", title: s.id, doing: [] };
      const r = c.run;
      const ms = Math.round(r.endedAt - r.startedAt);
      return {
        kind: `${r.type.toLowerCase()} run`,
        title: c.title,
        doing: [
          t < c.start ? (
            <span key="w" className="dim">
              Not started at this moment
            </span>
          ) : t < c.end ? (
            <span key="w" className="live">
              Running now · {ms} ms in real time
            </span>
          ) : (
            <span key="w">
              Took {ms} ms ·{" "}
              {r.error ? (
                <span style={{ color: TONE_COLORS.error }}>{r.status}</span>
              ) : (
                r.status
              )}
            </span>
          ),
        ],
      };
    }
    case "op": {
      const o = world.timeline.ops.find((x) => x.id === s.id);
      if (!o) return { kind: "operation", title: s.id, doing: [] };
      const past = o.points.filter((p) => p.at <= t);
      const at = past[past.length - 1];
      const last = o.points[o.points.length - 1];
      const loads = o.loads.filter((l) => l.from <= t);
      return {
        kind: "operation of the client",
        title: o.kind,
        doing: [
          !at ? (
            <span key="at" className="dim">
              Not started at this moment
            </span>
          ) : (
            <span key="at">
              {at === last ? "Ended at " : "Now at "}
              {labelOf(at.anchor)} · <span className="mono">{at.step}</span>
            </span>
          ),
          ...(o.code && o.errorAt !== undefined && o.errorAt <= t
            ? [
                <span key="code" style={{ color: TONE_COLORS.error }}>
                  Refused: <span className="mono">{o.code}</span>
                </span>,
              ]
            : []),
          ...(loads.length
            ? [
                <span key="loads">
                  Carried {loads.map((l) => loadName(l.load)).join(", ")}
                </span>,
              ]
            : []),
        ],
      };
    }
  }
}

/** The card's gap from the point it stands beside (px). */
const GAP = 22;

export function Card() {
  const selected = usePlayback((s) => s.selected);
  const detail = usePlayback((s) => s.detail);
  const open = usePlayback((s) => s.open);
  usePlayback((s) => Math.floor(s.time * 4));
  usePlayback((s) => s.version);
  const box = useRef<HTMLElement>(null);

  // Follow the point on the window; dock at the top right when it is off it.
  useEffect(() => {
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const el = box.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const W = window.innerWidth;
      const H = window.innerHeight;
      let x: number;
      let y: number;
      const sel = usePlayback.getState().selected;
      const aside =
        sel?.type === "part" && usePlayback.getState().open === sel.id;
      if (aside) {
        // Its inside is open: the card stands at the side, not over it.
        x = 16;
        y = 16;
      } else if (cardAt.on) {
        x = cardAt.x + GAP;
        if (x + w > W - 12) x = cardAt.x - GAP - w;
        y = cardAt.y - h / 2;
      } else {
        x = W - w - 16;
        y = 72;
      }
      x = Math.min(Math.max(12, x), W - w - 12);
      y = Math.min(Math.max(12, y), H - h - 96);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.dataset.docked = cardAt.on && !aside ? "" : "docked";
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (e.key !== "i" && e.key !== "I") return;
      const s = usePlayback.getState();
      if (s.selected) s.setDetail(!s.detail);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);

  if (!selected) return null;
  const state = currentState();
  const c = cardOf(selected, state);
  const covered = highlightOf(selected);
  const dealt = covered.contacts
    .map((x) => x.other)
    .filter((id, i, all) => all.indexOf(id) === i && placementOf(id));
  const { select, flyTo, setDetail } = usePlayback.getState();
  return (
    <aside className="card panel" ref={box} aria-label={c.title}>
      <div className="card-kind">
        {c.kind}
        {c.group && <span className="dim"> · in {c.group}</span>}
      </div>
      <h2>{c.title}</h2>
      {c.line && (
        <p className="card-line">
          {c.line.text}
          {c.line.from && (
            <span className="dim small">
              {" "}
              — the line of <span className="mono">{c.line.from}</span>
            </span>
          )}
        </p>
      )}
      {c.doing.length > 0 && (
        <div className="card-doing">
          {c.doing.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
      )}
      {dealt.length > 0 && (
        <div className="card-dealt small">
          <span className="dim">Dealt with </span>
          {dealt.slice(0, 3).map((id, i) => (
            <span key={id}>
              {i === 0
                ? ""
                : i === dealt.length - 1 && dealt.length <= 3
                  ? " and "
                  : ", "}
              <button
                className="link inline"
                onClick={() => select({ type: "part", id })}
              >
                {labelOf(id)}
              </button>
            </span>
          ))}
          {dealt.length > 3 && (
            <span className="dim"> and {dealt.length - 3} more</span>
          )}
        </div>
      )}
      <div className="card-actions">
        {!(selected.type === "part" && open === selected.id) && (
          <button
            onClick={() => {
              if (selected.type === "part" && c.opens)
                usePlayback.getState().openUp(selected.id);
              else flyTo(selected);
            }}
            title={c.opens ? "Go close: it opens up" : "Go there"}
          >
            {c.opens ? "Open up" : "Go there"}
          </button>
        )}
        <button
          aria-pressed={detail}
          onClick={() => setDetail(!detail)}
          title="Its links in the source and everything recorded on it (I)"
        >
          All of it
        </button>
        <button onClick={() => select(null)} aria-label="Close">
          ✕
        </button>
      </div>
    </aside>
  );
}
