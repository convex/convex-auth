import type { ReactNode } from "react";
import type { Link, SourceRef } from "../model/graph.ts";
import type { RowState, WorldState } from "../model/playback.ts";
import type { Derivation, Doc } from "../model/recording.ts";
import { linkLook, nounOf } from "../presentation.ts";
import { colorOf, nounOfPart, partOf, placementOf } from "../scene/look.ts";
import { DELETED_COLOR, TONE_COLORS } from "../scene/palette.ts";
import { currentState, usePlayback, world, type Selection } from "../store.ts";

const { timeline, presentation } = world;
const labelOf = (id: string) => partOf(id)?.label ?? id;
const chapterOf = (run: string) =>
  timeline.chapters.find((c) => c.run.id === run);

function Fields({ doc }: { doc: Doc }) {
  const entries = Object.entries(doc);
  if (!entries.length) return <div className="dim">{"{ } no fields"}</div>;
  return (
    <dl className="fields">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Facts({ facts }: { facts: [string, string][] }) {
  return <Fields doc={Object.fromEntries(facts)} />;
}

function Derived({ d }: { d?: Derivation }) {
  if (!d) return null;
  return (
    <div className="derived">
      <span className="pill" style={{ background: "#c3b5ff" }}>
        derived
      </span>{" "}
      {d.note}
    </div>
  );
}

function StatePill({ table, state }: { table: string; state?: string }) {
  if (!state) return null;
  const color =
    state === "deleted"
      ? DELETED_COLOR
      : (presentation.tables?.[table]?.states?.[state]?.color ?? "#555");
  return (
    <span className="pill" style={{ background: color }}>
      {state}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function PartLink({ id }: { id: string }) {
  const { select } = usePlayback.getState();
  return (
    <button className="link" onClick={() => select({ type: "part", id })}>
      <span style={{ color: colorOf(id) }}>●</span> {labelOf(id)}{" "}
      <span className="dim">· {nounOfPart(id)}</span>
    </button>
  );
}

function Where({ at }: { at: SourceRef | null }) {
  if (!at) return <span className="dim">no source in this repository</span>;
  return (
    <span className="mono src">
      {at.file}:{at.line}
    </span>
  );
}

function RunLink({ run }: { run: string }) {
  const { setTime, select } = usePlayback.getState();
  const c = chapterOf(run);
  if (!c) return <span className="mono dim">{run}</span>;
  return (
    <button
      className="link"
      onClick={() => {
        setTime(c.start);
        select({ type: "run", id: run });
      }}
    >
      {c.title}{" "}
      <span className="dim">
        · {Math.round(c.run.endedAt - c.run.startedAt)} ms real
      </span>
    </button>
  );
}

/** A part's links, grouped by direction and kind, each with its evidence. */
function Dependencies({ id, covered }: { id: string; covered: Set<string> }) {
  const groups = new Map<string, { other: string; link: Link }[]>();
  const seen = new Set<string>();
  for (const member of covered) {
    for (const [dir, list] of [
      ["out", world.index.out.get(member) ?? []],
      ["in", world.index.in.get(member) ?? []],
    ] as const) {
      for (const l of list) {
        if (seen.has(`${dir}:${l.id}`)) continue;
        seen.add(`${dir}:${l.id}`);
        const other = dir === "out" ? l.to : l.from;
        if (covered.has(other)) continue;
        const look = linkLook(presentation, l.kind);
        const key = `${dir === "out" ? look.verb : look.inverse}|${l.kind}`;
        groups.set(key, [...(groups.get(key) ?? []), { other, link: l }]);
      }
    }
  }
  if (!groups.size) return <span className="dim">none</span>;
  return (
    <>
      {[...groups].map(([key, items]) => {
        const [phrase, kind] = key.split("|");
        return (
          <details key={key} open={items.length <= 6}>
            <summary>
              <span
                className="swatch"
                style={{ background: linkLook(presentation, kind).color }}
              />
              {phrase} <span className="dim">({items.length})</span>
            </summary>
            {items.map(({ other, link }) => (
              <div key={link.id + other} className="dep">
                <PartLink id={other} />
                {covered.size > 1 && link.from !== id && link.to !== id && (
                  <div className="dim small">
                    via {labelOf(covered.has(link.from) ? link.from : link.to)}
                  </div>
                )}
                {link.via && (
                  <div className="dim small">how: {link.via.join(", ")}</div>
                )}
                {link.scope && (
                  <div className="dim small">holds in: {link.scope}</div>
                )}
                <div className="evidence">
                  {link.evidence.map((e, i) => (
                    <div key={i}>
                      <Where at={e} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </details>
        );
      })}
    </>
  );
}

function rowTitle(table: string, r: RowState) {
  const t = presentation.tables?.[table]?.title;
  if (t) {
    const filled = t
      .replace(/\{(\w+)\}/g, (_, k: string) => String(r.doc[k] ?? ""))
      .trim();
    if (filled) return filled;
  }
  return `…${r.id.slice(-6)}`;
}

function partBody(id: string, state: WorldState) {
  const part = partOf(id);
  const place = placementOf(id);
  const { select } = usePlayback.getState();
  if (!part)
    return {
      kind: "part",
      title: id,
      content: <p className="dim">Not in the map.</p>,
    };
  const island = world.layout.islands.find((i) => i.id === id);
  const covered = new Set<string>([id]);
  if (island) for (const m of island.members) covered.add(m);
  const children = world.layout.islands.filter((i) => i.parentIsland === id);
  const rows = state.tables.get(id) ?? [];
  const runs = world.recording.runs.filter(
    (r) =>
      r.function === id ||
      r.caller === id ||
      r.steps.some(
        (s) =>
          (s.kind === "call" && s.target === id) ||
          (s.kind === "log" && s.part === id),
      ) ||
      r.writes.some((w) => w.table === id),
  );
  const unresolved = [...covered].flatMap(
    (c) => world.index.unresolvedFrom.get(c) ?? [],
  );
  const summary =
    presentation.parts?.[id]?.summary ??
    part.facts.find(([k]) => k === "summary")?.[1];
  const byKind = new Map<string, number>();
  for (const m of island?.members ?? []) {
    const k = partOf(m)?.kind ?? "";
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  const active = state.active.get(id);
  return {
    kind: nounOfPart(id),
    title: part.label,
    color: place?.color,
    content: (
      <>
        {summary && <p>{summary}</p>}
        {part.observed && (
          <p className="observed">
            <span className="pill" style={{ background: TONE_COLORS.warn }}>
              observed
            </span>{" "}
            {part.observed}
          </p>
        )}
        <Section title="Source">
          <Where at={part.source} />
          <div className="mono dim small">{part.id}</div>
        </Section>
        {part.parent && (
          <Section title="Inside">
            <PartLink id={part.parent} />
          </Section>
        )}
        {part.facts.filter(([k]) => k !== "summary").length > 0 && (
          <Section title="Facts">
            <Facts facts={part.facts.filter(([k]) => k !== "summary")} />
          </Section>
        )}
        {part.fields && (
          <Section title={`Fields (${part.fields.length})`}>
            <dl className="fields">
              {part.fields.map((f) => (
                <div key={f.name}>
                  <dt>
                    {f.name}
                    {f.optional ? "?" : ""}
                  </dt>
                  <dd>{f.type}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}
        {island && (
          <Section title={`On this island (${island.members.length})`}>
            {[...byKind].map(([k, n]) => (
              <div key={k}>
                {n} {nounOf(presentation, k, n)}
              </div>
            ))}
            {children.map((c) => (
              <PartLink key={c.id} id={c.id} />
            ))}
          </Section>
        )}
        {(rows.length > 0 || part.kind === "table") && (
          <Section
            title={`Rows now (${rows.filter((r) => r.deletedAt === undefined).length})`}
          >
            {rows.length === 0 && (
              <span className="dim">none in the recording</span>
            )}
            {rows.map((r) => (
              <button
                key={r.id}
                className="link"
                onClick={() => select({ type: "row", table: id, id: r.id })}
              >
                <span className="mono">{rowTitle(id, r)}</span>{" "}
                <StatePill
                  table={id}
                  state={r.deletedAt !== undefined ? "deleted" : r.state}
                />
              </button>
            ))}
          </Section>
        )}
        {active && (
          <Section title="Now">
            <span className="live">
              running in {chapterOf(active.run)?.title}
            </span>
          </Section>
        )}
        {runs.length > 0 && (
          <Section
            title={`In the recording (${runs.length} run${runs.length === 1 ? "" : "s"})`}
          >
            {runs.map((r) => (
              <RunLink key={r.id} run={r.id} />
            ))}
          </Section>
        )}
        <Section
          title={
            island ? "Dependencies of the island and its parts" : "Dependencies"
          }
        >
          <Dependencies id={id} covered={covered} />
        </Section>
        {unresolved.length > 0 && (
          <Section title={`Unresolved (${unresolved.length})`}>
            {unresolved.map((u) => (
              <div key={u.id} className="dep">
                <div className="mono">{u.code}</div>
                <div className="small">{u.reason}</div>
                <div className="evidence">
                  <Where at={u.location} />
                </div>
              </div>
            ))}
          </Section>
        )}
      </>
    ),
  };
}

function body(
  s: Selection,
  state: WorldState,
): { kind: string; title: string; color?: string; content: ReactNode } {
  const { select } = usePlayback.getState();
  switch (s.type) {
    case "part":
      return partBody(s.id, state);
    case "row": {
      const row = state.tables.get(s.table)?.find((r) => r.id === s.id);
      return {
        kind: `row of ${labelOf(s.table)}`,
        title: row ? rowTitle(s.table, row) : s.id,
        color: colorOf(s.table),
        content: row ? (
          <>
            <Section title="Table">
              <PartLink id={s.table} />
            </Section>
            <Section title="Now">
              <StatePill
                table={s.table}
                state={row.deletedAt !== undefined ? "deleted" : row.state}
              />{" "}
              <span className="mono dim">_id {row.id}</span>
            </Section>
            <Section title="Fields">
              <Fields doc={row.doc} />
            </Section>
            <Section title="History">
              {row.history.map((h, i) => (
                <div key={i} className="dep">
                  <span className="mono">{h.op}</span>{" "}
                  {h.run ? (
                    <RunLink run={h.run} />
                  ) : (
                    <span className="dim">at the start of the recording</span>
                  )}
                  {h.derived && <Derived d={{ rule: "", note: h.derived }} />}
                </div>
              ))}
            </Section>
          </>
        ) : (
          <p className="dim">This row does not exist at this moment.</p>
        ),
      };
    }
    case "cargo": {
      const held = state.holdings.get(s.holder)?.find((c) => c.row === s.row);
      return {
        kind: "held by " + labelOf(s.holder),
        title: held?.label ?? s.row,
        content: (
          <>
            {held?.derived ? (
              <Derived d={held.derived} />
            ) : (
              <p>
                From the recording: the page stored this secret ({held?.secret}
                ); its value never appears.
              </p>
            )}
            <Section title="The row">
              <button
                className="link"
                onClick={() =>
                  select({ type: "row", table: s.table, id: s.row })
                }
              >
                <span className="mono">{s.row}</span>{" "}
                <span className="dim">· {labelOf(s.table)}</span>
              </button>
            </Section>
          </>
        ),
      };
    }
    case "movement": {
      const m = timeline.movements.find((x) => x.id === s.id);
      if (!m) return { kind: "movement", title: s.id, content: null };
      const flying = m.start <= state.time && state.time < m.end;
      return {
        kind: m.kind,
        title: m.label,
        content: (
          <>
            <p>{m.detail}</p>
            <Derived d={m.derived} />
            <Section title="From, to">
              <PartLink id={m.from} />
              <PartLink id={m.to} />
            </Section>
            {m.cargo.length > 0 && (
              <Section title="Carries">
                {m.cargo.map((c) => (
                  <div key={c.row}>
                    {c.label} <Derived d={c.derived} />
                  </div>
                ))}
              </Section>
            )}
            <Section title="Run">
              <RunLink run={m.run} />
              {flying ? (
                <span className="live">in flight now</span>
              ) : (
                <span className="dim">not in flight at this moment</span>
              )}
            </Section>
          </>
        ),
      };
    }
    case "run": {
      const c = chapterOf(s.id);
      if (!c) return { kind: "run", title: s.id, content: null };
      const r = c.run;
      return {
        kind: `${r.type.toLowerCase()} run`,
        title: c.title,
        color: colorOf(r.function),
        content: (
          <>
            <p>
              Real duration <b>{(r.endedAt - r.startedAt).toFixed(1)} ms</b>,
              shown over {(c.end - c.start).toFixed(1)} s.
              {r.error && (
                <span style={{ color: TONE_COLORS.error }}> {r.error}</span>
              )}
            </p>
            {r.section && (
              <Section title="Scenario step">
                <span>{r.section}</span>
              </Section>
            )}
            <Section title="Function, caller">
              <PartLink id={r.function} />
              <PartLink id={r.caller} />
            </Section>
            {r.scheduledBy && (
              <Section title="Scheduled by">
                <RunLink run={r.scheduledBy.run} />
                <Derived d={r.scheduledBy.derived} />
              </Section>
            )}
            <Section title={`Steps (${r.steps.length})`}>
              {r.steps.map((st, i) => (
                <div
                  key={i}
                  className="mono small"
                  style={{
                    color:
                      "tone" in st && st.tone !== "normal"
                        ? TONE_COLORS[st.tone]
                        : undefined,
                  }}
                >
                  {st.kind === "call" &&
                    `call ${st.callKind ?? ""} ${labelOf(st.target)}`}
                  {st.kind === "return" && `return ${labelOf(st.target)}`}
                  {st.kind === "note" && st.text}
                  {st.kind === "log" && `${st.level} ${st.message}`}
                </div>
              ))}
            </Section>
            <Section title={`Writes (${r.writes.length})`}>
              {r.writes.map((w, i) => (
                <div key={i} className="dep">
                  <button
                    className="link"
                    onClick={() =>
                      select({ type: "row", table: w.table, id: w.row })
                    }
                  >
                    <span className="mono">{w.op}</span> {labelOf(w.table)}{" "}
                    <span className="mono dim">…{w.row.slice(-6)}</span>
                  </button>
                  <Derived d={w.derived} />
                </div>
              ))}
            </Section>
            {(r.carriesIn.length > 0 || r.carriesOut.length > 0) && (
              <Section title="Cargo">
                {r.carriesIn.map((x) => (
                  <div key={`in${x.row}`}>
                    request carries {x.label} <Derived d={x.derived} />
                  </div>
                ))}
                {r.carriesOut.map((x) => (
                  <div key={`out${x.row}`}>
                    response carries {x.label} <Derived d={x.derived} />
                  </div>
                ))}
              </Section>
            )}
            {r.before.length + r.after.length > 0 && (
              <Section
                title={`The page, around this run (${r.before.length + r.after.length})`}
              >
                {[...r.before, ...r.after].map((it, i) => (
                  <div
                    key={i}
                    className="dep small"
                    style={{
                      color:
                        it.tone !== "normal" ? TONE_COLORS[it.tone] : undefined,
                    }}
                  >
                    <span className="dim">{it.kind}</span> {it.text}
                    {it.candidates && it.candidates.length > 0 && (
                      <div>
                        one of these runs, the data does not say which:
                        {it.candidates.map((c) => (
                          <RunLink key={c} run={c} />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </Section>
            )}
            <Section title="As recorded">
              <Facts facts={r.facts} />
            </Section>
          </>
        ),
      };
    }
  }
}

/** What the selected thing is and its state at the current time. */
export function Inspector() {
  const selected = usePlayback((s) => s.selected);
  // The inspector shows the state at the current time.
  usePlayback((s) => s.time);
  const { select, flyTo } = usePlayback.getState();
  if (!selected) return null;
  const state = currentState();
  const b = body(selected, state);
  return (
    <aside
      className="inspector panel"
      style={{ ["--accent" as string]: b.color ?? "#cfe6ff" }}
    >
      <header>
        <div className="kind">{b.kind}</div>
        <h2>{b.title}</h2>
        <div className="actions">
          <button onClick={() => flyTo(selected)}>Fly to</button>
          <button onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
      </header>
      <div className="content">{b.content}</div>
    </aside>
  );
}
