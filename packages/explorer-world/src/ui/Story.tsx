/**
 * A story (`model/story.ts`), told over the world: a caption at the top of
 * the left column, above the play-by-play, with the stop's words, Back and
 * Next, "Play to next" and Exit. Keys: `]` next, `[` back, `p` play to next.
 *
 * On Next or Back, time goes to the stop's line and holds; the list shows
 * the line; the stop's thing is selected, opened up if the stop says so,
 * and the camera goes to frame it. That is the one place a story moves the
 * camera: the viewer asked to be taken there. Exit leaves time, selection
 * and camera where they are.
 *
 * A story that starts with a press has a button that presses that control;
 * it binds to the lines of that press as they arrive. Until a stop's line
 * has arrived it reads as waiting for the code; a stop whose pin or check
 * did not hold in this run says so.
 */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { requestAction, useControls } from "../controls.ts";
import { playByPlayOf, type PlayLine } from "../model/playByPlay.ts";
import {
  bindStory,
  playUntil,
  pressSections,
  stopTime,
  type BoundStop,
  type Holds,
  type Story as StoryOf,
} from "../model/story.ts";
import { project, usePlayback, world } from "../store.ts";

interface StoryState {
  /** The list of stories is open. */
  menu: boolean;
  story: StoryOf | null;
  /** The stop shown; -1 before the first. */
  at: number;
  /** Presses of the story's control there were before it pressed it. */
  skip: number;
  /** The stop the viewer went to that had not arrived: it is gone to when it does. */
  pending: number | null;
  /**
   * Whether Next and Back take the camera to the stop. Off, the camera
   * stays wherever the viewer put it, through the whole story. Remembered.
   */
  camera: boolean;
}

const CAMERA_KEY = "explorer.story.camera";

function readCamera(): boolean {
  try {
    return localStorage.getItem(CAMERA_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Turns the camera's following of the story on or off; it moves nothing now. */
export function setStoryCamera(on: boolean) {
  useStory.setState({ camera: on });
  try {
    localStorage.setItem(CAMERA_KEY, on ? "1" : "0");
  } catch {
    // A page without storage keeps it for this visit only.
  }
}

export const useStory = create<StoryState>(() => ({
  menu: false,
  story: null,
  at: -1,
  skip: 0,
  pending: null,
  camera: readCamera(),
}));

/** The part a look names: `prefix*` is the first of the line's parts that starts so. */
function lookPart(name: string, b: BoundStop): string | null {
  if (!name.endsWith("*")) return world.index.part.has(name) ? name : null;
  const prefix = name.slice(0, -1);
  const lines = [b.line, b.to].filter(Boolean) as PlayLine[];
  return (
    lines.flatMap((l) => l.parts).find((p) => p.startsWith(prefix)) ??
    [...world.index.part.keys()].find((p) => p.startsWith(prefix)) ??
    null
  );
}

let listSeq = 0;

/**
 * Shows a bound stop: time at its line, held; the line in the list; its
 * thing selected; and, with `camera`, the camera framing it (opening a part
 * up takes the camera to it, so without `camera` it is only selected).
 */
function show(b: BoundStop, camera: boolean) {
  const t = stopTime(b);
  if (t === null || !b.line) return;
  const s = usePlayback.getState();
  s.setTime(t);
  s.pause();
  const look = b.stop.look;
  const part = look ? lookPart(look.part, b) : null;
  if (part) {
    s.select({ type: "part", id: part });
    if (camera) {
      if (look?.open) s.openUp(part);
      else s.flyTo({ type: "part", id: part });
    }
  } else if (b.line.target) s.select(b.line.target);
  usePlayback.setState({
    listTo: { line: b.line.id, section: b.line.section, seq: ++listSeq },
  });
}

/** Where "play to next" holds, while it plays. */
let holdAt: number | null = null;

const MARK: Record<Holds, string> = { holds: "✓", missing: "!", waiting: "…" };

export function Story() {
  const { menu, story, at, skip, pending, camera } = useStory();
  usePlayback((s) => s.version);
  const controls = useControls();
  const sections = playByPlayOf(world);
  const bound = useMemo(
    () => (story ? bindStory(story, sections, { skip }) : null),
    [story, sections, skip],
  );
  const [pressed, setPressed] = useState(false);

  const go = (i: number, camera = true) => {
    if (!bound) return;
    const j = Math.max(-1, Math.min(i, bound.stops.length - 1));
    holdAt = null;
    const b = bound.stops[j];
    useStory.setState({
      at: j,
      pending: b && b.status === "waiting" ? j : null,
    });
    if (b) show(b, camera && useStory.getState().camera);
  };

  // A stop gone to before its line arrived: shown when it does.
  useEffect(() => {
    if (!bound || pending === null) return;
    const b = bound.stops[pending];
    if (b?.line) {
      useStory.setState({ pending: null });
      show(b, useStory.getState().camera);
    }
  }, [bound, pending]);

  // "Play to next": hold at the next stop's line, and show it there (the
  // camera stays where it is: the viewer asked to watch, not to be taken).
  useEffect(
    () =>
      usePlayback.subscribe((s) => {
        if (holdAt === null || s.time < holdAt - 1e-6) return;
        if (!s.playing) {
          holdAt = null;
          return;
        }
        const until = holdAt;
        holdAt = null;
        const st = useStory.getState();
        const b = st.story
          ? bindStory(st.story, playByPlayOf(world), { skip: st.skip })
          : null;
        const next = b?.stops.findIndex(
          (x, k) => k > st.at && stopTime(x) === until,
        );
        if (b && next !== undefined && next >= 0) {
          useStory.setState({ at: next });
          show(b.stops[next], false);
        } else {
          s.pause();
          s.setTime(until);
        }
      }),
    [],
  );

  const playToNext = () => {
    if (!bound || at < 0) return;
    const until = playUntil(bound.stops, at);
    const from = stopTime(bound.stops[at]);
    if (until === null || from === null) return;
    const s = usePlayback.getState();
    s.setTime(from);
    s.setSpeed(1);
    holdAt = until;
    s.play();
  };

  // Keys that the world does not use: `]` next, `[` back, `p` play to next.
  useEffect(() => {
    if (!story) return;
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "]") go(at + 1);
      else if (e.key === "[") go(at - 1);
      else if (e.key === "p" || e.key === "P") playToNext();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  });

  const stories = project.source.stories ?? [];

  if (menu && !story)
    return (
      <aside className="story story-menu panel" aria-label="Stories">
        <header>
          <span>Stories</span>
          <button
            className="close"
            onClick={() => useStory.setState({ menu: false })}
            aria-label="Close the stories"
          >
            ×
          </button>
        </header>
        <ul>
          {stories.map((s) => (
            <li key={s.id}>
              <button
                onClick={(e) => {
                  e.currentTarget.blur();
                  setPressed(false);
                  useStory.setState({
                    menu: false,
                    story: s,
                    at: -1,
                    skip: 0,
                    pending: null,
                  });
                }}
              >
                <span className="title">{s.title}</span>
                {s.about && <span className="about">{s.about}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    );

  if (!story || !bound) return null;

  const b = at >= 0 ? bound.stops[at] : null;
  const n = bound.stops.length;
  const press = story.press;
  const action = press
    ? controls.state?.actions.find((a) => a.id === press.action)
    : undefined;
  const busy =
    controls.asking === press?.action || controls.state?.busy === press?.action;
  const pressNow = () => {
    if (!press) return;
    useStory.setState({
      skip: pressSections(story, playByPlayOf(world)).length,
    });
    setPressed(true);
    void requestAction(press.action);
  };
  const pressState = !press
    ? null
    : busy
      ? "The page is doing it; the lines come in as the code reports them."
      : bound.section
        ? bound.section.closed
          ? pressed
            ? "Done. The stops are bound to the lines of this press."
            : "The stops are bound to the last time it was pressed. Press again to see a new run."
          : "The lines come in as the code reports them."
        : `Waiting for ${press.label}.`;

  const lineSaid = (l: PlayLine) => (
    <span className="said">
      <span className="who">{l.who}</span> {l.text}
    </span>
  );

  return (
    <aside className="story panel" aria-label={`Story: ${story.title}`}>
      <header>
        <span className="title">{story.title}</span>
        <span className="count">
          {at < 0 ? `${n} stops` : `${at + 1} / ${n}`}
        </span>
        <button
          className="close"
          onClick={() => {
            holdAt = null;
            useStory.setState({ story: null, at: -1, pending: null });
          }}
          title="Exit the story; the world stays as it is"
        >
          Exit
        </button>
      </header>
      {press && (at < 0 || !bound.section) && (
        <div className="press">
          <button
            onClick={(e) => {
              e.currentTarget.blur();
              pressNow();
            }}
            disabled={busy || action?.enabled === false}
            title={action?.reason ?? undefined}
          >
            Press {press.label}
          </button>
          <span className="state">{pressState}</span>
        </div>
      )}
      {at < 0 ? (
        story.about && <p className="say">{story.about}</p>
      ) : b ? (
        <>
          <p className={`say${b.status === "note" ? " note" : ""}`}>
            {b.stop.say}
          </p>
          {b.status === "note" ? (
            <p className="status note">
              A note: not something the code reported.
            </p>
          ) : b.status === "missing" ? (
            <p className="status missing">This did not happen in this run.</p>
          ) : b.status === "waiting" ? (
            <p className="status waiting">Waiting for the code.</p>
          ) : (
            <p className="status reported">
              {b.to ? "From " : ""}
              {lineSaid(b.line!)}
              {b.to && <> to {lineSaid(b.to)}</>}
            </p>
          )}
          {b.stop.look?.inside && b.status !== "missing" && (
            <p className="inside">
              Inside: <code>{b.stop.look.inside}</code>
            </p>
          )}
          {b.checks.length > 0 && (
            <ul className="checks">
              {b.checks.map((c, i) => (
                <li key={i} className={c.status}>
                  <span className="mark" aria-hidden>
                    {MARK[c.status]}
                  </span>
                  {c.check.say}
                  {c.status === "missing" && (
                    <span className="why"> This did not hold in this run.</span>
                  )}
                  {c.status === "waiting" && (
                    <span className="why"> Waiting for the code.</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <div className="camera">
        <label title="Whether Next and Back take the camera to the stop">
          <input
            type="checkbox"
            checked={camera}
            onChange={(e) => {
              setStoryCamera(e.currentTarget.checked);
              e.currentTarget.blur();
            }}
          />
          Camera follows the story
        </label>
        {!camera && b?.line && (
          <button
            className="go"
            onClick={(e) => {
              e.currentTarget.blur();
              show(b, true);
            }}
            title="Take the camera to this stop, this once"
          >
            Go there
          </button>
        )}
      </div>
      <footer>
        <button
          onClick={(e) => {
            e.currentTarget.blur();
            go(at - 1);
          }}
          disabled={at < 0}
          title="Back ([)"
        >
          Back
        </button>
        <button
          onClick={(e) => {
            e.currentTarget.blur();
            playToNext();
          }}
          disabled={at < 0 || !b?.line || playUntil(bound.stops, at) === null}
          title="Play from this stop to the next, then hold (p)"
        >
          Play to next
        </button>
        <button
          onClick={(e) => {
            e.currentTarget.blur();
            go(at + 1);
          }}
          disabled={at >= n - 1}
          title="Next (])"
        >
          {at < 0 ? "Begin" : "Next"}
        </button>
      </footer>
    </aside>
  );
}
