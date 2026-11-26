import { useEffect, useRef } from "react";
import { usePlayback, world } from "../store.ts";

const SPEEDS = [0.25, 0.5, 1, 2, 4];
const { timeline } = world;

function format(t: number) {
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${Math.floor((t - s) * 10)}`;
}

/** Play, pause, step, scrub and speed. The bar shows one segment per function run. */
export function Timeline() {
  const time = usePlayback((s) => s.time);
  const playing = usePlayback((s) => s.playing);
  const speed = usePlayback((s) => s.speed);
  const { toggle, step, setSpeed, setTime, pause } = usePlayback.getState();
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const seek = (clientX: number) => {
    const el = bar.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTime(((clientX - rect.left) / rect.width) * timeline.duration);
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

  const current = world.stateAt(time).chapterIndex;

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
          <span className="dim">/ {format(timeline.duration)}</span>
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
        {timeline.chapters.map((c, i) => (
          <div
            key={c.run.id}
            className={`chapter ${i === current ? "current" : ""} ${c.run.tone === "normal" ? "" : c.run.tone}`}
            style={{
              left: `${(c.start / timeline.duration) * 100}%`,
              width: `${((c.end - c.start) / timeline.duration) * 100}%`,
            }}
            title={c.title}
          >
            <span>{c.title}</span>
            <i
              className="commit"
              style={{
                left: `${((c.commitAt - c.start) / (c.end - c.start)) * 100}%`,
              }}
            />
          </div>
        ))}
        <div
          className="head"
          style={{ left: `${(time / timeline.duration) * 100}%` }}
        />
      </div>
    </div>
  );
}
