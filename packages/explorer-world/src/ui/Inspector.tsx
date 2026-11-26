import type { ReactNode } from "react";
import type { RowState, WorldState } from "../model/playback.ts";
import { GATE, SCHEDULER, SIGNER } from "../model/schedule.ts";
import type { Doc } from "../model/types.ts";
import { REGION_COLORS, STATE_COLORS } from "../scene/palette.ts";
import { usePlayback, world, type Selection } from "../store.ts";

const { structure, timeline } = world;
const regionOf = (id: string) => structure.regions.find((r) => r.id === id);
const fnOf = (id: string) => structure.functions.find((f) => f.id === id);
const tableOf = (id: string) => structure.tables.find((t) => t.id === id);
const chapterOf = (execution: string) =>
  timeline.chapters.find((c) => c.execution.id === execution);

const PLACES: Record<string, { title: string; summary: string }> = {
  [GATE]: {
    title: "Token check",
    summary:
      "Every request from a client enters the deployment here. The platform verifies the access token's signature and expiry before the app's function runs; the function then sees the caller's identity.",
  },
  [SIGNER]: {
    title: "Deployment key",
    summary:
      "The platform signs each access token (a JWT) with the deployment's key when a session is issued or refreshed.",
  },
  [SCHEDULER]: {
    title: "Scheduler",
    summary:
      "Runs functions that a committed mutation scheduled. Here: the cleanup of a revoked session's refresh tokens.",
  },
};

function Fields({ doc }: { doc: Doc }) {
  const entries = Object.entries(doc);
  if (!entries.length) return <div className="dim">{"{ } — no fields"}</div>;
  return (
    <dl className="fields">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatePill({ state }: { state?: string }) {
  if (!state) return null;
  return (
    <span
      className="pill"
      style={{ background: STATE_COLORS[state] ?? "#555" }}
    >
      {state}
    </span>
  );
}

function rowTitle(r: RowState) {
  return r.label ?? `…${r.id.slice(-6)}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Link({ to, children }: { to: Selection; children: ReactNode }) {
  const { select, flyTo } = usePlayback.getState();
  return (
    <button
      className="link"
      onClick={() => select(to)}
      onDoubleClick={() => {
        select(to);
        flyTo(to);
      }}
    >
      {children}
    </button>
  );
}

function body(
  s: Selection,
  state: WorldState,
): { kind: string; title: string; color?: string; content: ReactNode } {
  switch (s.type) {
    case "region": {
      const r = regionOf(s.id)!;
      const fns = structure.functions.filter((f) => f.region === r.id);
      const tables = structure.tables.filter((t) => t.region === r.id);
      const children = structure.regions.filter((x) => x.parent === r.id);
      const held = state.holdings.get(r.id) ?? [];
      return {
        kind:
          r.kind === "component"
            ? "component"
            : r.kind === "client"
              ? "client"
              : r.kind,
        title: r.label,
        color: REGION_COLORS[r.id],
        content: (
          <>
            {r.package && <p className="dim mono">{r.package}</p>}
            <p>{r.summary}</p>
            {held.length > 0 && (
              <Section title="Holds now">
                {held.map((k) => (
                  <div key={k.label} className="mono">
                    {k.kind} token · {k.label}
                  </div>
                ))}
              </Section>
            )}
            {children.length > 0 && (
              <Section title="Contains">
                {children.map((c) => (
                  <Link key={c.id} to={{ type: "region", id: c.id }}>
                    {c.label}
                  </Link>
                ))}
              </Section>
            )}
            {fns.length > 0 && (
              <Section title="Functions">
                {fns.map((f) => (
                  <Link key={f.id} to={{ type: "function", id: f.id }}>
                    <span className={state.active.has(f.id) ? "live" : ""}>
                      {f.name}
                    </span>
                  </Link>
                ))}
              </Section>
            )}
            {tables.length > 0 && (
              <Section title="Tables">
                {tables.map((t) => (
                  <Link key={t.id} to={{ type: "table", id: t.id }}>
                    {t.name}{" "}
                    <span className="dim">
                      ·{" "}
                      {
                        (state.tables.get(t.id) ?? []).filter(
                          (x) => x.deletedAt === undefined,
                        ).length
                      }{" "}
                      rows
                    </span>
                  </Link>
                ))}
              </Section>
            )}
          </>
        ),
      };
    }
    case "function": {
      const f = fnOf(s.id)!;
      const active = state.active.get(f.id);
      const runs = timeline.activations.filter((a) => a.node === f.id);
      return {
        kind: `${f.visibility} ${f.type}${f.scheduled ? " · scheduled" : ""}`,
        title: f.name,
        color: REGION_COLORS[f.region],
        content: (
          <>
            <p className="dim">
              in{" "}
              <Link to={{ type: "region", id: f.region }}>
                {regionOf(f.region)?.label}
              </Link>
            </p>
            <p>{f.summary}</p>
            <Section title="Now">
              {active ? (
                <span className="live">
                  running · {chapterOf(active.execution)?.execution.title}
                </span>
              ) : (
                <span className="dim">idle</span>
              )}
            </Section>
            <Section title={`Runs in this recording · ${runs.length}`}>
              {runs.length === 0 && <span className="dim">none</span>}
              {runs.map((a, i) => (
                <button
                  key={i}
                  className="link"
                  onClick={() => usePlayback.getState().setTime(a.start)}
                >
                  {chapterOf(a.execution)?.execution.title}{" "}
                  <span className="dim">· jump</span>
                </button>
              ))}
            </Section>
          </>
        ),
      };
    }
    case "table": {
      const t = tableOf(s.id)!;
      const rows = state.tables.get(t.id) ?? [];
      return {
        kind: "table",
        title: t.name,
        color: REGION_COLORS[t.region],
        content: (
          <>
            <p className="dim">
              in{" "}
              <Link to={{ type: "region", id: t.region }}>
                {regionOf(t.region)?.label}
              </Link>
            </p>
            <p>{t.summary}</p>
            <Section title="Fields">
              <div className="mono dim">
                {t.fields.length ? t.fields.join(", ") : "none"}
              </div>
            </Section>
            <Section
              title={`Rows now · ${rows.filter((r) => r.deletedAt === undefined).length}`}
            >
              {rows.length === 0 && <span className="dim">empty</span>}
              {rows.map((r) => (
                <Link key={r.id} to={{ type: "row", table: t.id, id: r.id }}>
                  <span className="mono">{rowTitle(r)}</span>{" "}
                  <StatePill
                    state={r.deletedAt !== undefined ? "deleted" : r.state}
                  />
                </Link>
              ))}
            </Section>
          </>
        ),
      };
    }
    case "row": {
      const t = tableOf(s.table)!;
      const r = (state.tables.get(t.id) ?? []).find((x) => x.id === s.id);
      return {
        kind: `row of ${t.name}`,
        title: r ? rowTitle(r) : s.id,
        color: REGION_COLORS[t.region],
        content: r ? (
          <>
            <p>
              <StatePill
                state={r.deletedAt !== undefined ? "deleted" : r.state}
              />{" "}
              <span className="mono dim">_id {r.id}</span>
            </p>
            <Section title="Document">
              <Fields doc={r.doc} />
            </Section>
            <Section title="History">
              {r.history.map((h, i) => (
                <button
                  key={i}
                  className="link"
                  onClick={() => usePlayback.getState().setTime(h.at)}
                >
                  <span className="mono">{h.op}</span> ·{" "}
                  {chapterOf(h.execution)?.execution.title}
                  {"state" in h.doc ? ` → ${h.doc.state}` : ""}
                </button>
              ))}
            </Section>
          </>
        ) : (
          <p className="dim">
            This row does not exist at this moment of the run. Scrub to when it
            does, or pick it again from its table.
          </p>
        ),
      };
    }
    case "movement": {
      const m = timeline.movements.find((x) => x.id === s.id)!;
      const live = state.travellers.find((x) => x.movement.id === m.id);
      return {
        kind: m.kind,
        title: m.label,
        content: (
          <>
            <p>{m.detail}</p>
            <Section title="Route">
              <div className="mono">
                {nameOf(m.from)} → {m.via ? `${nameOf(m.via)} → ` : ""}
                {nameOf(m.to)}
              </div>
            </Section>
            {m.tokens.length > 0 && (
              <Section title="Carries">
                {m.tokens.map((k) => (
                  <div key={k.label} className="mono">
                    {k.kind} token · {k.label}
                  </div>
                ))}
              </Section>
            )}
            <Section title="Now">
              {live ? (
                <span className="live">
                  in flight · {Math.round(live.progress * 100)}%
                </span>
              ) : (
                <span className="dim">not in flight at this moment</span>
              )}
            </Section>
            <p className="dim">
              Part of: {chapterOf(m.execution)?.execution.title}
            </p>
          </>
        ),
      };
    }
    case "place": {
      const p = PLACES[s.id];
      return {
        kind: "Convex platform",
        title: p.title,
        color: REGION_COLORS.platform,
        content: <p>{p.summary}</p>,
      };
    }
    case "token": {
      const held = (state.holdings.get(s.holder) ?? []).find(
        (k) => k.label === s.label,
      );
      const row = held?.row
        ? (state.tables.get("auth:refreshTokens") ?? []).find(
            (r) => r.id === held.row,
          )
        : undefined;
      return {
        kind: held?.kind === "access" ? "access token" : "refresh token",
        title: s.label,
        color: REGION_COLORS[s.holder],
        content: (
          <>
            <p>
              Held by{" "}
              <Link to={{ type: "region", id: s.holder }}>
                {regionOf(s.holder)?.label}
              </Link>
              .
            </p>
            {held?.kind === "access" ? (
              <p>
                A JWT signed with the deployment's key. The platform checks it
                on every request; it is short-lived and is renewed by a refresh.
              </p>
            ) : (
              <p>
                An opaque secret. The core stores only its SHA-256 hash, in the
                row below. Presenting it rotates it; presenting it after its
                successor was redeemed revokes the session.
              </p>
            )}
            {row && (
              <Section title="Its row in auth.refreshTokens">
                <Link
                  to={{ type: "row", table: "auth:refreshTokens", id: row.id }}
                >
                  <span className="mono">{rowTitle(row)}</span>{" "}
                  <StatePill
                    state={row.deletedAt !== undefined ? "deleted" : row.state}
                  />
                </Link>
              </Section>
            )}
          </>
        ),
      };
    }
  }
}

function nameOf(anchor: string) {
  return (
    fnOf(anchor)?.name ??
    regionOf(anchor)?.label ??
    PLACES[anchor]?.title ??
    anchor
  );
}

/** What the selected thing is and its state at the current time. */
export function Inspector() {
  const selected = usePlayback((s) => s.selected);
  const time = usePlayback((s) => s.time);
  const { select, flyTo } = usePlayback.getState();
  if (!selected) return null;
  const state = world.stateAt(time);
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
