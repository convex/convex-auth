/**
 * The play-by-play list (`model/playByPlay.ts`): what the running code
 * reported, one line each, in a narrow column on the left that can be
 * folded to a tab.
 *
 * Quiet by default. Every section heading shows (what was pressed, what the
 * page did on open, what nobody asked for): a few words each, the outline
 * of the session. Under the section being played, only the block being
 * played (an operation with its steps, a run with its steps and writes),
 * which is what the world is showing now. A click on a heading opens the
 * whole section, one line per block; a click on a block's caret opens its
 * steps. Before anything is pressed and while nothing plays, even the page
 * load stays shut: the world comes first.
 *
 * Tied to the playhead both ways: the line being played is lit and kept in
 * view, the lines after it read as not yet; a click on a line takes time
 * there and holds it, and marks the thing in the world (it selects it; the
 * camera stays). What is selected in the world marks its lines here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  lineAt,
  playByPlayOf,
  type PlayLine,
  type PlaySection,
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
  const playing = usePlayback((s) => s.playing);
  const selected = usePlayback((s) => s.selected);
  // A live recording grows: the list is made again with the world.
  usePlayback((s) => s.version);
  const [folded, setFolded] = useState(readFolded);
  // What the viewer opened or shut by hand, by section or block id.
  const [opened, setOpened] = useState<Map<string, boolean>>(new Map());
  // The line clicked last: it is the one lit while time stays where the
  // click put it (lines that happen at the same moment light the clicked one).
  const [picked, setPicked] = useState<{ id: string; time: number } | null>(
    null,
  );
  const sections = playByPlayOf(world);
  const pickedLine =
    picked && Math.abs(picked.time - time) < 1e-6
      ? sections.flatMap((s) => s.lines).find((l) => l.id === picked.id)
      : undefined;
  const current = pickedLine ?? lineAt(sections, time);
  const anyPress = sections.some((s) => s.kind === "press" && s.at <= time);

  // The first line about the selection opens its section and block.
  const selectedLine = useMemo(() => {
    if (!selected) return null;
    for (const s of sections)
      for (const l of s.lines) if (marks(l, selected)) return l;
    return null;
  }, [sections, selected]);

  const isOpen = (id: string, auto: boolean) => opened.get(id) ?? auto;
  const toggle = (id: string, now: boolean) =>
    setOpened((m) => new Map(m).set(id, !now));

  const list = useRef<HTMLDivElement>(null);
  const lit = useRef<HTMLLIElement>(null);
  useEffect(() => {
    lit.current?.scrollIntoView({ block: "nearest" });
  }, [current?.id, folded]);

  if (!sections.length) return null;

  if (folded)
    return (
      <button
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

  const sectionAuto = (s: PlaySection) =>
    (current?.section === s.id && (s.kind !== "open" || anyPress || playing)) ||
    selectedLine?.section === s.id;

  return (
    <nav className="playlist" aria-label="What happened" ref={list}>
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
          // Opened by hand: every block. Else, the section being played
          // shows the block being played only.
          const full = opened.get(s.id) === true;
          const open = full || (opened.get(s.id) !== false && sectionAuto(s));
          const future = s.at > time + 1e-6;
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
              className={`section ${s.kind}${future ? " later" : ""}${current?.section === s.id ? " now" : ""}`}
            >
              <button
                className="heading"
                onClick={() => toggle(s.id, full)}
                aria-expanded={full}
              >
                {s.title}
              </button>
              {open && (
                <ol className="lines">
                  {blocks.map((b) => {
                    const head = b[0];
                    const auto =
                      current?.block === head.block ||
                      selectedLine?.block === head.block;
                    if (!full && !auto) return null;
                    const blockOpen = isOpen(head.block, auto);
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
                    return shown.map((l, i) => {
                      const now = l.id === current?.id;
                      const later = l.at > time + 1e-6;
                      return (
                        <li
                          key={l.id}
                          ref={now ? lit : undefined}
                          className={`line d${l.depth}${now ? " now" : ""}${later ? " later" : ""}${marks(l, selected) ? " marked" : ""}${s.kind === "unasked" ? " faint" : ""}`}
                          data-line={l.id}
                        >
                          {i === 0 && b.length > 1 ? (
                            <button
                              className="caret"
                              onClick={() => toggle(head.block, blockOpen)}
                              aria-expanded={blockOpen}
                              aria-label={blockOpen ? "Shut" : "Open"}
                            >
                              {blockOpen ? "▾" : "▸"}
                            </button>
                          ) : (
                            <span className="caret" />
                          )}
                          <button className="what" onClick={() => go(l)}>
                            <Mark line={l} />
                            <span className="who">{l.who}</span>
                            <span className="text">{l.text}</span>
                            {l.code && <code>{l.code}</code>}
                          </button>
                        </li>
                      );
                    });
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
