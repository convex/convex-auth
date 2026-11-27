import { useEffect, useRef, useState } from "react";
import { parseNdjson } from "../adapters/convexRecording.ts";
import { stageFromEvents } from "../adapters/browserStage.ts";
import { RECORDINGS, liveEvents } from "./sources.ts";
import { modelOf, spanOf, timeOf, useStage } from "./store.ts";

/** Draws again on every animation frame while mounted. */
function useEveryFrame() {
  const [, tick] = useState(0);
  useEffect(() => {
    let id = 0;
    const loop = () => {
      tick((n) => (n + 1) % 1e6);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}

const seconds = (ms: number) => {
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0
    ? `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`
    : `${s.toFixed(1)} s`;
};

/** Where in a recording the person did something: marks on the track. */
function marks(model: ReturnType<typeof modelOf>): number[] {
  const out: number[] = [];
  for (const e of model.elements) for (const u of e.uses) out.push(u.time);
  for (const l of model.locations) out.push(l.time);
  return out;
}

/** The menu of recordings to replay. */
function ReplayMenu({ onClose }: { onClose: () => void }) {
  const replay = useStage((s) => s.replay);
  const status = useStage((s) => s.liveStatus);
  const file = useRef<HTMLInputElement>(null);
  const open = (name: string, text: string) => {
    replay(
      name,
      stageFromEvents(parseNdjson(text), useStage.getState().labels),
    );
    onClose();
  };
  return (
    <div className="stage-menu panel" role="menu">
      <div className="stage-menu-title">Replay</div>
      {status !== "none" && (
        <button
          role="menuitem"
          onClick={() => {
            replay(
              "This session",
              stageFromEvents(liveEvents(), useStage.getState().labels),
            );
            onClose();
          }}
        >
          This session, from the start
        </button>
      )}
      {Object.entries(RECORDINGS).map(([name, load]) => (
        <button
          key={name}
          role="menuitem"
          onClick={() => void load().then((text) => open(name, text))}
        >
          Saved: {name}
        </button>
      ))}
      <button role="menuitem" onClick={() => file.current?.click()}>
        Open a recording file...
      </button>
      <input
        ref={file}
        type="file"
        accept=".ndjson,.jsonl,.json,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then((text) => open(f.name, text));
        }}
      />
    </div>
  );
}

/**
 * The time handle, the Live and Replay controls, and where the time shown
 * is. Dragging the handle holds the time there; letting go at the right end
 * of a live recording returns to live.
 */
export function Timeline() {
  useEveryFrame();
  const s = useStage();
  const [menu, setMenu] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const now = Date.now();
  const span = spanOf(s, now);
  const t = timeOf(s, now);
  const model = modelOf(s);
  const length = Math.max(span.end - span.start, 1);
  const k = Math.min(1, Math.max(0, (t - span.start) / length));
  const isLive = s.source.kind === "live";
  const atLive = isLive && s.clock.mode === "live";

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const sp = spanOf(useStage.getState());
    return {
      time: sp.start + x * (sp.end - sp.start),
      end: clientX >= r.right - 6,
    };
  };

  return (
    <div className="stage-timeline panel">
      <div className="stage-modes" role="group" aria-label="Live or replay">
        <button
          className={atLive ? "on" : ""}
          onClick={() => s.goLive()}
          title="Show the page as it is used now"
        >
          <span className={`dot ${s.liveStatus}`} />{" "}
          {atLive || !isLive ? "Live" : "Back to live"}
        </button>
        <button
          className={isLive ? "" : "on"}
          onClick={() => setMenu((m) => !m)}
          aria-haspopup="menu"
          title="Replay a recording"
        >
          Replay
        </button>
        {menu && <ReplayMenu onClose={() => setMenu(false)} />}
      </div>
      {!isLive && (
        <button
          className="stage-play"
          onClick={() => (s.clock.mode === "playing" ? s.pause() : s.play())}
        >
          {s.clock.mode === "playing" ? "Pause" : "Play"}
        </button>
      )}
      <div
        ref={track}
        className="stage-track"
        role="slider"
        aria-label="Time"
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(t - span.start)}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          s.hold(timeAt(e.clientX).time);
        }}
        onPointerMove={(e) => {
          if (dragging.current) s.hold(timeAt(e.clientX).time);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          const { time, end } = timeAt(e.clientX);
          if (end && useStage.getState().source.kind === "live") s.goLive();
          else s.hold(time);
        }}
      >
        <div className="stage-track-bar" />
        {marks(model).map((m, i) =>
          m >= span.start && m <= span.end ? (
            <div
              key={i}
              className="stage-mark"
              style={{ left: `${((m - span.start) / length) * 100}%` }}
            />
          ) : null,
        )}
        <div className="stage-handle" style={{ left: `${k * 100}%` }} />
      </div>
      <div className="stage-clock mono">
        {atLive
          ? "now"
          : isLive
            ? `${seconds(span.end - t)} ago`
            : `${seconds(t - span.start)} / ${seconds(length)}`}
      </div>
      {!isLive && (
        <div className="stage-source dim">
          {s.source.kind === "replay" ? s.source.name : ""}
        </div>
      )}
    </div>
  );
}
