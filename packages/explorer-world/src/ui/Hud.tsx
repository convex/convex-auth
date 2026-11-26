import { useEffect, useRef } from "react";
import { hover, usePlayback, world } from "../store.ts";

const { timeline } = world;

/** What is happening now: the function run and its current step. */
export function Caption() {
  const time = usePlayback((s) => s.time);
  const state = world.stateAt(time);
  const chapter = state.chapter;
  if (!chapter) {
    return (
      <div className="caption">
        <div className="step">Press play to watch a recorded run</div>
      </div>
    );
  }
  // A beat of the previous run does not caption the next one.
  const beat = state.beat?.run === chapter.run.id ? state.beat : null;
  return (
    <div
      className={`caption tone-${beat?.tone ?? "normal"}`}
      key={beat ? beat.start : 0}
    >
      <div className="run">
        <span className="n">{state.chapterIndex + 1}</span>
        {chapter.title}
        <span className="dim mono">
          {" "}
          · {chapter.run.facts.find(([k]) => k === "function")?.[1]} ·{" "}
          {(chapter.run.endedAt - chapter.run.startedAt).toFixed(1)} ms real
        </span>
      </div>
      <div className="step">{beat?.text ?? "…"}</div>
    </div>
  );
}

/** The run, chapter by chapter: click one to jump there. */
export function Chapters() {
  const time = usePlayback((s) => s.time);
  const current = world.stateAt(time).chapterIndex;
  const { setTime } = usePlayback.getState();
  return (
    <nav className="chapters panel">
      <h1>
        {world.presentation.title}
        {world.presentation.subtitle && (
          <span> · {world.presentation.subtitle}</span>
        )}
      </h1>
      <ol>
        {timeline.chapters.map((c, i) => (
          <li
            key={c.run.id}
            className={i === current ? "current" : i < current ? "past" : ""}
          >
            <button
              onClick={() => {
                setTime(c.start);
                usePlayback.getState().select({ type: "run", id: c.run.id });
              }}
            >
              <span className="n">{i + 1}</span>
              <span className={`tone-${c.run.tone}`}>{c.title}</span>
              <span className="ms">
                {Math.round(c.run.endedAt - c.run.startedAt)} ms
              </span>
            </button>
          </li>
        ))}
      </ol>
      <p className="note">
        A recording of {world.recording.runs.length} runs, slowed to human
        speed; real durations at right. {world.graph.parts.length} parts and{" "}
        {world.graph.links.length} dependencies on the map.
      </p>
    </nav>
  );
}

/** Camera controls and the name of what is under the pointer. */
export function CameraHud() {
  const director = usePlayback((s) => s.director);
  const overlays = usePlayback((s) => s.overlays);
  const { setDirector, flyTo, toggleOverlay } = usePlayback.getState();
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const el = tip.current;
      if (!el) return;
      el.textContent = hover.label;
      el.style.opacity = hover.label ? "1" : "0";
      el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
      document.body.style.cursor = hover.label ? "pointer" : "";
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return (
    <>
      <div className="camera panel">
        <button
          onClick={() => flyTo("overview")}
          title="Back to the overview (O)"
        >
          Overview
        </button>
        <button
          className={director ? "on" : ""}
          onClick={() => setDirector(!director)}
          title="Follow the action (F)"
        >
          Follow
        </button>
        <span className="sep" />
        <button
          className={overlays.relations ? "on" : ""}
          onClick={() => toggleOverlay("relations")}
          title="Arcs between related islands (R)"
        >
          Relations
        </button>
        <button
          className={overlays.links ? "on" : ""}
          onClick={() => toggleOverlay("links")}
          title={`Every dependency: ${world.graph.links.length} (L)`}
        >
          All links
        </button>
        <button
          className={overlays.unresolved ? "on" : ""}
          onClick={() => toggleOverlay("unresolved")}
          title={`Every unresolved dependency: ${world.graph.unresolved.length} (U)`}
        >
          Unresolved
        </button>
        <span className="keys">
          drag orbit · right-drag pan · scroll zoom · WASD fly · Q/E down/up ·
          click inspect
        </span>
      </div>
      <div className="tip" ref={tip} />
    </>
  );
}

/** Keyboard shortcuts for playback and the camera. */
export function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const s = usePlayback.getState();
      if (e.key === " ") {
        e.preventDefault();
        s.toggle();
      } else if (e.key === "ArrowRight") s.step(1);
      else if (e.key === "ArrowLeft") s.step(-1);
      else if (e.key === "o" || e.key === "O") s.flyTo("overview");
      else if (e.key === "f" || e.key === "F") s.setDirector(!s.director);
      else if (e.key === "r" || e.key === "R") s.toggleOverlay("relations");
      else if (e.key === "l" || e.key === "L") s.toggleOverlay("links");
      else if (e.key === "u" || e.key === "U") s.toggleOverlay("unresolved");
      else if (e.key === "Escape") s.select(null);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
}
