/**
 * The play-by-play list (`model/playByPlay.ts`): what the running code
 * reported, one line each, in a narrow column on the left that can be
 * folded to a tab.
 *
 * Every section heading shows: what was pressed, what the page did on
 * open, and, faint, what nobody asked for. The last thing pressed (by the
 * playhead) stands open until something else is pressed or the viewer opens
 * another section: one line per thing it set off, in order (an operation,
 * a run, a load, a change of storage), and the block being played open
 * with its steps (a run's own steps while it plays). What nobody asked for
 * stays one faint heading, lit while it plays, until the viewer opens it.
 *
 * Tied to the playhead both ways: the line being played is lit and kept in
 * view, the lines after it read as not yet; a click on a line takes time
 * there and holds it, and marks the thing in the world (it selects it; the
 * camera stays). What is selected in the world marks its lines here.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  lineAt,
  newestPress,
  openSectionOf,
  playByPlayOf,
  type Chosen,
  type PlayLine,
} from "../model/playByPlay.ts";
import { opColor } from "../scene/Operations.tsx";
import {
  MOVEMENT_COLORS,
  STATE_COLORS,
  TONE_COLORS,
} from "../scene/palette.ts";
import { usePlayback, world, type Selection } from "../store.ts";

const FOLDED_KEY = "explorer.playByPlay.folded";

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? "1" : "0");
  } catch {
    // A page without storage keeps it for this visit only.
  }
}

/** Whether a line is about the thing selected in the world. */
function marks(line: PlayLine, sel: Selection | null): boolean {
  if (!sel) return false;
  const t = line.target;
  switch (sel.type) {
    case "op":
      return line.op === sel.id;
    case "run":
      return t?.type === "run" && t.id === sel.id;
    case "part":
      return line.parts.includes(sel.id);
    case "row":
      return (
        (t?.type === "row" && t.table === sel.table && t.id === sel.id) ||
        line.parts.includes(sel.table)
      );
    case "cargo":
      return line.parts.includes(sel.holder);
    case "movement": {
      const run = world.timeline.movements.find((m) => m.id === sel.id)?.run;
      return Boolean(run) && t?.type === "run" && t.id === run;
    }
  }
}

/** The mark a line carries: the look of its thing in the world, small. */
function Mark({ line }: { line: PlayLine }) {
  const op = line.op
    ? world.timeline.ops.find((o) => o.id === line.op)
    : undefined;
  const tone = line.tone !== "normal" ? TONE_COLORS[line.tone] : null;
  const color =
    tone ??
    (line.mark === "state" && line.state
      ? STATE_COLORS[line.state]
      : line.mark === "send"
        ? MOVEMENT_COLORS.request
        : line.mark === "answer"
          ? MOVEMENT_COLORS.response
          : line.mark === "call"
            ? MOVEMENT_COLORS.call
            : line.mark === "write"
              ? MOVEMENT_COLORS.write
              : op
                ? opColor(op)
                : line.mark === "key"
                  ? "var(--live)"
                  : "var(--dim)");
  const run =
    line.mark === "run" && line.code ? ` run-${line.code.split(",")[0]}` : "";
  return (
    <span
      className={`mark mark-${line.mark}${run}`}
      style={{ color }}
      aria-hidden
    />
  );
}

export function PlayList() {
  const time = usePlayback((s) => s.time);
  const selected = usePlayback((s) => s.selected);
  // A live recording grows: the list is made again with the world.
  usePlayback((s) => s.version);
  const [folded, setFolded] = useState(readFolded);
  // Blocks the viewer opened or shut by hand.
  const [opened, setOpened] = useState<Map<string, boolean>>(new Map());
  // The section the viewer opened by hand, under the newest press then.
  const [chosen, setChosen] = useState<Chosen | null>(null);
  // The line clicked last: it is the one lit while time stays where the
  // click put it (lines that happen at the same moment light the clicked one).
  const [picked, setPicked] = useState<{ id: string; time: number } | null>(
    null,
  );
  const sections = playByPlayOf(world);
  const pickedLine =
    picked && Math.abs(picked.time - time) < 0.01
      ? sections.flatMap((s) => s.lines).find((l) => l.id === picked.id)
      : undefined;
  const current = pickedLine ?? lineAt(sections, time);
  // The last thing pressed, by the playhead: open until something else is
  // pressed or the viewer opens another section.
  const newest = newestPress(sections);
  const openSection = openSectionOf(sections, time, chosen);
  const choose = (section: string | null) =>
    setChosen({ section, under: newest });
  // Opened by the viewer, what nobody asked for plays at the pace of the
  // rest (see `Timeline.quiet`); shut, it passes quickly.
  const watching =
    !folded &&
    sections.some((s) => s.id === openSection && s.kind === "unasked");
  useEffect(() => {
    if (usePlayback.getState().watchQuiet !== watching)
      usePlayback.setState({ watchQuiet: watching });
  }, [watching]);

  // The lines about the selection, and the first of them, which opens its
  // block.
  const selectedLine = useMemo(() => {
    if (!selected) return null;
    for (const s of sections)
      for (const l of s.lines) if (marks(l, selected)) return l;
    return null;
  }, [sections, selected]);
  // A new selection opens the section of its first line, once: the list
  // growing, or a press, does not open it again.
  const lineRef = useRef(selectedLine);
  lineRef.current = selectedLine;
  const newestRef = useRef(newest);
  newestRef.current = newest;
  const selectionKey = selected ? JSON.stringify(selected) : null;
  useEffect(() => {
    const line = lineRef.current;
    if (line) setChosen({ section: line.section, under: newestRef.current });
  }, [selectionKey]);

  const toggle = (id: string, now: boolean) =>
    setOpened((m) => new Map(m).set(id, !now));

  const nav = useRef<HTMLElement>(null);
  const tab = useRef<HTMLButtonElement>(null);
  const lit = useRef<HTMLLIElement>(null);
  useEffect(() => {
    lit.current?.scrollIntoView({ block: "nearest" });
  }, [current?.id, folded, openSection]);
  // A card docked at the top left (a part opened up) keeps the corner: the
  // list stands under it.
  useEffect(() => {
    let frame = 0;
    const place = () => {
      frame = requestAnimationFrame(place);
      const card = document.querySelector<HTMLElement>(".card");
      const top =
        card?.dataset.docked === "docked"
          ? card.getBoundingClientRect().bottom + 10
          : 18;
      for (const el of [nav.current, tab.current])
        if (el && el.style.top !== `${top}px`) el.style.top = `${top}px`;
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, []);

  if (!sections.length) return null;

  if (folded)
    return (
      <button
        ref={tab}
        className="playlist-tab"
        onClick={() => {
          setFolded(false);
          writeFolded(false);
        }}
        title="What happened, line by line"
        aria-label="Show the play-by-play"
      >
        <span>What happened</span>
      </button>
    );

  const go = (line: PlayLine) => {
    const s = usePlayback.getState();
    s.setTime(line.at + 0.02);
    s.pause();
    setPicked({ id: line.id, time: usePlayback.getState().time });
    if (line.target) s.select(line.target);
  };

  const row = (l: PlayLine, caret: ReactNode, faint: boolean) => {
    const now = l.id === current?.id;
    const later = l.at > time + 1e-6;
    return (
      <li
        key={l.id}
        ref={now ? lit : undefined}
        className={`line d${l.depth}${now ? " now" : ""}${later ? " later" : ""}${marks(l, selected) ? " marked" : ""}${faint ? " faint" : ""}`}
        data-line={l.id}
      >
        {caret ?? <span className="caret" />}
        <button
          className="what"
          onClick={(e) => {
            // The keys (space, arrows) stay the world's.
            e.currentTarget.blur();
            go(l);
          }}
        >
          <Mark line={l} />
          <span className="body">
            <span className="who">{l.who}</span> {l.text}
            {l.code && <code>{l.code}</code>}
            {l.note && <span className="note">{l.note}</span>}
          </span>
        </button>
      </li>
    );
  };

  return (
    <nav className="playlist" aria-label="What happened" ref={nav}>
      <header>
        <span>What happened</span>
        <button
          className="fold"
          onClick={() => {
            setFolded(true);
            writeFolded(true);
          }}
          title="Fold away"
          aria-label="Fold the play-by-play away"
        >
          ‹
        </button>
      </header>
      <ol className="sections">
        {sections.map((s) => {
          const open = openSection === s.id;
          const faint = s.kind === "unasked";
          // Blocks of the section, each its first line and the rest.
          const blocks: PlayLine[][] = [];
          for (const l of s.lines) {
            const last = blocks.at(-1);
            if (last && last[0].block === l.block) last.push(l);
            else blocks.push([l]);
          }
          return (
            <li
              key={s.id}
              className={`section ${s.kind}${open ? " expanded" : ""}${s.at > time + 1e-6 ? " later" : ""}${current?.section === s.id ? " now" : ""}`}
            >
              <button
                className="heading"
                onClick={() => choose(open ? null : s.id)}
                aria-expanded={open}
              >
                {s.title}
              </button>
              {open && (
                <ol className="lines">
                  {blocks.flatMap((b) => {
                    const head = b[0];
                    // The block being played opens with its steps.
                    const auto =
                      current?.block === head.block ||
                      selectedLine?.block === head.block;
                    const blockOpen = opened.get(head.block) ?? auto;
                    const caret =
                      b.length > 1 ? (
                        <button
                          className="caret"
                          onClick={() => toggle(head.block, blockOpen)}
                          aria-expanded={blockOpen}
                          aria-label={blockOpen ? "Shut" : "Open"}
                        >
                          {blockOpen ? "▾" : "▸"}
                        </button>
                      ) : null;
                    // What ran inside a function shows while it plays, or
                    // when the block was opened by hand.
                    const shown = !blockOpen
                      ? [head]
                      : opened.get(head.block)
                        ? b
                        : b.filter(
                            (l) =>
                              !l.inRun ||
                              l.inRun === current?.inRun ||
                              (current?.target?.type === "run" &&
                                current.target.id === l.inRun) ||
                              l.id === selectedLine?.id,
                          );
                    return shown.map((l, i) =>
                      row(l, i === 0 ? caret : null, faint),
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
