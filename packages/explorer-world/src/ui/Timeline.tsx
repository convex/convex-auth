import { useEffect, useRef } from "react";
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
 * The time line of live mode: a thin line over this session with a handle.
 * Dragging the handle goes back in time and holds there; "Back to live"
 * returns to the newest action and plays on. Play plays on from where the
 * handle is, at shown pace, and follows live again once it reaches the
 * newest moment. While it follows live, it says so with a dot.
 */
export function LiveLine() {
  const time = usePlayback((s) => s.time);
  const held = usePlayback((s) => s.held);
  const playing = usePlayback((s) => s.playing);
  const replaying = usePlayback((s) => s.replaying);
  const live = usePlayback((s) => s.live);
  usePlayback((s) => s.version);
  const { setTime, pause, skipToLive, toggle } = usePlayback.getState();
  const following = !held && !replaying;
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const span = Math.max(world.timeline.duration, 1e-6);
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
  if (!live) return null;
  const state =
    live.connection === "open"
      ? "live"
      : live.connection === "ended"
        ? "ended"
        : live.connection === "lost"
          ? "lost"
          : "connecting";
  return (
    <div
      className="liveline"
      data-following={following ? "yes" : "no"}
      data-connection={state}
    >
      <button
        type="button"
        className="play"
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
      <div
        className="track"
        ref={bar}
        onPointerDown={(e) => {
          dragging.current = true;
          pause();
          seek(e.clientX);
        }}
      >
        {world.timeline.actions.map((a, i) => (
          <i
            key={i}
            className="press"
            style={{ left: `${(a / span) * 100}%` }}
          />
        ))}
        <div className="fill" style={{ width: `${(time / span) * 100}%` }} />
        <div className="handle" style={{ left: `${(time / span) * 100}%` }} />
      </div>
      {!following ? (
        <button
          type="button"
          className="back"
          onClick={skipToLive}
          title="Back to live (End)"
        >
          Back to live
        </button>
      ) : (
        <span className="state" title={live.url}>
          <span className="dot" aria-hidden />
          {state}
        </span>
      )}
    </div>
  );
}
