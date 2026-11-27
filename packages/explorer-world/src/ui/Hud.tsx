import { useEffect, useRef } from "react";
import { PROJECTS } from "../project.ts";
import {
  currentState,
  hover,
  projectName,
  usePlayback,
  world,
} from "../store.ts";

/** What is happening now: the function run and its current step. */
export function Caption() {
  // Re-renders when the beat changes, not on every frame.
  usePlayback((s) => {
    void s.time;
    const st = currentState();
    return `${st.chapterIndex}:${st.beat?.start ?? ""}`;
  });
  const state = currentState();
  const chapter = state.chapter;
  // Quiet when nothing is happening: one line, only while a beat plays.
  const beat =
    chapter && state.beat?.run === chapter.run.id ? state.beat : null;
  if (!beat || state.time >= beat.end) return null;
  return (
    <div className={`caption tone-${beat.tone}`} key={beat.start}>
      <div className="step">{beat.text}</div>
    </div>
  );
}

/** The run, chapter by chapter: click one to jump there. */
const recordings = Object.keys(PROJECTS[projectName]?.timelines ?? {});

export function Chapters() {
  // Re-renders when the current run changes, not on every frame.
  const current = usePlayback((s) => {
    void s.time;
    return currentState().chapterIndex;
  });
  // A live recording grows.
  usePlayback((s) => s.version);
  const live = usePlayback((s) => s.live !== null);
  const { setTime } = usePlayback.getState();
  return (
    <nav className="chapters panel">
      <h1>{world.presentation.title}</h1>
      {!live && recordings.length > 1 && (
        <div className="recordings" role="group" aria-label="Recording">
          {recordings.map((r) => (
            <a
              key={r}
              className={r === world.recording.name ? "on" : ""}
              href={`?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), recording: r, t: "0" })}`}
            >
              {r}
            </a>
          ))}
        </div>
      )}
      <details>
        <summary>{world.timeline.chapters.length} runs</summary>
        <ol>
          {world.timeline.chapters.map((c, i) => [
            c.section &&
              c.section !== world.timeline.chapters[i - 1]?.section && (
                <li key={`s${i}`} className="section">
                  {c.section}
                </li>
              ),
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
            </li>,
          ])}
        </ol>
      </details>
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
        <button onClick={() => flyTo("home")} title="Home (H)">
          Home
        </button>
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
        <details className="layers">
          <summary title="Overlays">Layers</summary>
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
        </details>
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
      else if (e.key === "h" || e.key === "H") s.flyTo("home");
      else if (e.key === "f" || e.key === "F") s.setDirector(!s.director);
      else if (e.key === "r" || e.key === "R") s.toggleOverlay("relations");
      else if (e.key === "l" || e.key === "L") s.toggleOverlay("links");
      else if (e.key === "u" || e.key === "U") s.toggleOverlay("unresolved");
      else if (e.key === "Escape") s.select(null);
      else if (e.key === "End" && s.live) s.skipToLive();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
}
