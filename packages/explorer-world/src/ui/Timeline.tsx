import { useEffect, useRef } from "react";
import { behindLive } from "../live.ts";
import { currentState, usePlayback, world } from "../store.ts";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

function format(t: number) {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${Math.floor((t - s) * 10)}`;
}

/** Play, pause, step, scrub and speed. The bar shows one segment per function run. */
export function Timeline() {
  const time = usePlayback((s) => s.time);
  const playing = usePlayback((s) => s.playing);
  const speed = usePlayback((s) => s.speed);
  // A live recording grows while paused, too.
  usePlayback((s) => s.version);
  const { toggle, step, setSpeed, setTime, pause } = usePlayback.getState();
  // The bar spans the timeline; an empty one still has a width.
  const span = Math.max(world.timeline.duration, 1e-6);
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const seek = (clientX: number) => {
    const el = bar.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTime(((clientX - rect.left) / rect.width) * span);
  };

  useEffect(() => {
    const move = (e: PointerEvent) => dragging.current && seek(e.clientX);
    const up = () => (dragging.current = false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  const current = currentState().chapterIndex;

  return (
    <div className="timeline panel">
      <div className="transport">
        <button
          className="icon"
          onClick={() => step(-1)}
          title="Step back (←)"
          aria-label="Step back"
        >
          <svg viewBox="0 0 24 24">
            <path d="M6 5h2v14H6zM20 5v14L9 12z" />
          </svg>
        </button>
        <button
          className="icon play"
          onClick={toggle}
          title="Play / pause (space)"
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <svg viewBox="0 0 24 24">
              <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24">
              <path d="M7 4v16l13-8z" />
            </svg>
          )}
        </button>
        <button
          className="icon"
          onClick={() => step(1)}
          title="Step forward (→)"
          aria-label="Step forward"
        >
          <svg viewBox="0 0 24 24">
            <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
          </svg>
        </button>
        <span className="clock">
          {format(time)}{" "}
          <span className="dim">/ {format(world.timeline.duration)}</span>
        </span>
        <LiveControl />
        <div className="speeds" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={s === speed ? "on" : ""}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <div
        className="bar"
        ref={bar}
        onPointerDown={(e) => {
          dragging.current = true;
          pause();
          seek(e.clientX);
        }}
      >
        {world.timeline.chapters.map((c, i) => (
          <div
            key={c.run.id}
            className={`chapter ${i === current ? "current" : ""} ${c.run.tone === "normal" ? "" : c.run.tone}`}
            style={{
              left: `${(c.start / span) * 100}%`,
              width: `${((c.end - c.start) / span) * 100}%`,
            }}
            title={c.title}
          >
            <i
              className="commit"
              style={{
                left: `${((c.commitAt - c.start) / (c.end - c.start)) * 100}%`,
              }}
            />
          </div>
        ))}
        <div className="head" style={{ left: `${(time / span) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * For a live recording: whether it is still recording, how far the playhead
 * is behind the newest run, and a button that skips to it.
 */
function LiveControl() {
  const live = usePlayback((s) => s.live);
  const time = usePlayback((s) => s.time);
  usePlayback((s) => s.version);
  if (!live) return null;
  const behind = behindLive(world.timeline, time);
  const atEdge = behind.runs === 0;
  const state =
    live.connection === "ended"
      ? "ended"
      : live.connection === "open"
        ? "recording"
        : live.connection === "lost"
          ? "lost"
          : "connecting";
  return (
    <div className={`live ${state} ${atEdge ? "at-edge" : "behind"}`}>
      <span className="dot" aria-hidden />
      <span className="status" title={live.url}>
        {state === "recording" ? "Live" : state}
      </span>
      <span className="lag" data-runs={behind.runs}>
        {atEdge
          ? "up to date"
          : `${behind.runs} run${behind.runs === 1 ? "" : "s"} · ${Math.round(behind.seconds)} s behind`}
      </span>
      {live.placedBehind > 0 && (
        <span
          className="late"
          title="Runs that reached the world after the playhead had passed their place in time; scrub back to see them"
        >
          {live.placedBehind} late
        </span>
      )}
      <button
        onClick={() => usePlayback.getState().skipToLive()}
        disabled={atEdge}
        title="Play the newest run (End)"
      >
        Skip to live
      </button>
    </div>
  );
}
