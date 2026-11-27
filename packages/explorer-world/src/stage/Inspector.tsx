import type { ReactNode } from "react";
import { clientTree } from "./sources.ts";
import { stageAt, type Held, type StageModel } from "./model.ts";
import { modelOf, timeOf, useStage, type Selection } from "./store.ts";

const CLIENT_PARTS = clientTree();

const rel = (model: StageModel, t: number) =>
  `+${((t - model.start) / 1000).toFixed(2)} s`;

function Value({ value }: { value: unknown }) {
  return (
    <pre className="stage-json mono">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Secrets({ ids, model }: { ids: string[]; model: StageModel }) {
  if (!ids.length) return null;
  return (
    <div className="stage-secrets">
      {ids.map((id) => {
        const s = model.secrets.get(id);
        return (
          <div key={id} className="stage-secret">
            <div>
              <b>{id}</b>{" "}
              <span className="dim">
                {s
                  ? s.type === "jwt"
                    ? "a JWT"
                    : "an opaque token"
                  : "a token"}
                , shown by its label: the recording never holds its text.
              </span>
            </div>
            {s?.claims && <Value value={s.claims} />}
            {s && s.rows.length > 0 && (
              <div className="dim">
                Stored on the server as: {s.rows.join(", ")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** What the static things are; the recording does not show their interior. */
const THINGS: Record<string, { title: string; text: string }> = {
  page: {
    title: "Page",
    text: "The app's page, live on the screen. The elements the person used stand here, each lit when used.",
  },
  client0: {
    title: "The app's code",
    text: "Not observed: the recorder sees what leaves the page and what it stores, not which code ran. Nothing here moves.",
  },
  client1: {
    title: "The auth client",
    text: "Not observed: the recorder sees what leaves the page and what it stores, not which code ran. Nothing here moves.",
  },
  client2: {
    title: "The data client",
    text: "Not observed: the recorder sees what leaves the page and what it stores, not which code ran. Nothing here moves.",
  },
  local: {
    title: "localStorage",
    text: "What the page keeps in localStorage, by key. A token is one object, named by its secret label.",
  },
  cookies: {
    title: "Cookies",
    text: "The browser's cookies, read every half second; a cookie that lived shorter can be missed.",
  },
  socket: {
    title: "WebSocket",
    text: "The sync connection to the backend. Each message is one object, out on the left lane, back on the right.",
  },
  http: {
    title: "HTTP",
    text: "The page's HTTP requests: each leaves, waits at its exit for the response, and comes back.",
  },
};

function Body({
  sel,
  model,
  t,
}: {
  sel: Selection;
  model: StageModel;
  t: number;
}) {
  const labels = useStage((s) => s.labels);
  switch (sel.type) {
    case "thing": {
      const thing = THINGS[sel.id];
      const title = sel.id.startsWith("client")
        ? labels.client[Number(sel.id.slice(6))]
        : thing?.title;
      const at = stageAt(model, t);
      return (
        <>
          <h3>{title}</h3>
          <p>{thing?.text}</p>
          {sel.id === "page" && at.path && (
            <p>
              Now at <span className="mono">{at.path}</span>.
            </p>
          )}
          {sel.id === "local" && (
            <p>{at.local.filter((s) => !s.leaving).length} keys now.</p>
          )}
          {sel.id === "socket" && (
            <p>{at.socketOpen ? "Open now." : "Closed now."}</p>
          )}
        </>
      );
    }
    case "part": {
      const part =
        CLIENT_PARTS.find((m) => m.id === sel.id) ??
        CLIENT_PARTS.flatMap((m) => m.children).find((c) => c.id === sel.id);
      if (!part) return null;
      return (
        <>
          <h3>{part.name}</h3>
          <p className="dim">
            A {part.kind} of the structure map that runs in the browser
            {part.file ? (
              <>
                , in <span className="mono">{part.file}</span>
              </>
            ) : null}
            .
          </p>
          {part.children.length > 0 && (
            <p>Holds {part.children.map((c) => c.name).join(", ")}.</p>
          )}
          <p className="dim">
            Whether it ran is not recorded yet, so nothing here moves.
          </p>
        </>
      );
    }
    case "exit": {
      const exit = model.exits.find((e) => e.id === sel.id);
      const n = model.flights.filter(
        (f) => f.exit === sel.id && f.time <= t,
      ).length;
      return (
        <>
          <h3>{exit?.label}</h3>
          <p>
            Outside the browser: <span className="mono">{exit?.host}</span>. The
            stage shows what goes to it and comes back, not what happens inside.
          </p>
          <p>{n} messages so far.</p>
        </>
      );
    }
    case "element": {
      const el = model.elements.find((e) => e.key === sel.key);
      if (!el) return null;
      const uses = el.uses.filter((u) => u.time <= t);
      return (
        <>
          <h3>{el.label}</h3>
          <p className="dim mono">{el.key}</p>
          <ul className="stage-list">
            {uses.map((u) => (
              <li key={u.id}>
                <span className="mono dim">{rel(model, u.time)}</span>{" "}
                {u.action}
                {u.action === "type" &&
                  (u.value === null
                    ? " (a password: its text never leaves the page)"
                    : ` "${u.value}"`)}
                {u.action === "key" && ` ${u.value}`}
              </li>
            ))}
          </ul>
        </>
      );
    }
    case "slot": {
      const slots =
        sel.area === "cookie"
          ? model.cookies
          : sel.area === "session"
            ? model.session
            : model.local;
      const slot = slots.find((s) => s.key === sel.key);
      if (!slot) return null;
      const now: Held | undefined = slot.held.find(
        (h) => h.from <= t && (h.to === null || h.to > t),
      );
      return (
        <>
          <h3>{slot.name}</h3>
          <p className="dim">
            {sel.area === "cookie"
              ? "A cookie"
              : sel.area === "session"
                ? "sessionStorage"
                : "localStorage"}
            {now ? `, set at ${rel(model, now.from)}` : ", not held now"}
          </p>
          {now && <Value value={now.value} />}
          {now && <Secrets ids={now.secrets} model={model} />}
          {slot.attrs && <Value value={slot.attrs} />}
          <ul className="stage-list">
            {slot.held
              .filter((h) => h.from <= t)
              .map((h) => (
                <li key={h.eventId}>
                  <span className="mono dim">{rel(model, h.from)}</span> set
                  {h.to !== null && h.to <= t && (
                    <>
                      , <span className="mono dim">{rel(model, h.to)}</span>{" "}
                      gone
                    </>
                  )}
                </li>
              ))}
          </ul>
        </>
      );
    }
    case "flight": {
      const f = model.flights.find((x) => x.id === sel.id);
      if (!f) return null;
      const exit = model.exits.find((e) => e.id === f.exit);
      return (
        <>
          <h3>{f.label}</h3>
          <p className="dim">
            {f.via === "socket" ? "WebSocket" : "HTTP"},{" "}
            {f.direction === "out"
              ? `to ${exit?.label}`
              : `from ${exit?.label}`}
            , {rel(model, f.time)}
            {f.endTime !== null &&
              `, answered after ${Math.round(f.endTime - f.time)} ms`}
            {f.status !== null && `, status ${f.status}`}
          </p>
          <Secrets ids={f.secrets} model={model} />
          <Value value={f.detail} />
        </>
      );
    }
  }
}

/** Opens on a click on something of the stage, and says what it is now. */
export function Inspector() {
  const s = useStage();
  const sel = s.selection;
  if (!sel) return null;
  const model = modelOf(s);
  const t = timeOf(s);
  const content: ReactNode = <Body sel={sel} model={model} t={t} />;
  return (
    <aside className="stage-inspector panel">
      <button
        className="stage-close"
        onClick={() => s.select(null)}
        aria-label="Close"
      >
        Close
      </button>
      {content}
    </aside>
  );
}
