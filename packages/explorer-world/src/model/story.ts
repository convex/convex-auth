/**
 * Stories: a guided walk over what the running code reported.
 *
 * A story is an ordered list of stops. Each stop has words a person wrote
 * (`say`) and, unless it is a note, a pin: a matcher for a line of the
 * play-by-play (`playByPlay.ts`), or a span between two such lines. It may
 * name a thing to look at, and checks: a line that must be in the stop's
 * operation, or one that must not be.
 *
 * The words never stand in for the code. A stop is bound to the lines of a
 * run: its pin and its checks either hold, or did not happen in this run, or
 * have not arrived yet (a press still being recorded). A stop with no pin is
 * a note, and is never shown as something that happened.
 *
 * A story that starts with a press binds to the lines of that press: the
 * newest section of the list pressed with its label, from a time on.
 *
 * @module
 */
import { allLines, type PlayLine, type PlaySection } from "./playByPlay.ts";

/** What finds a line. Every field given must hold. */
export interface Match {
  /** A step's name (`storage.read`). */
  step?: string;
  /** An operation's kind (`init`): the operation's own line. */
  op?: string;
  /** The part that reported the step (`module:browser/storage`). */
  who?: string;
  /** Fields of the step's report, each equal (`{ "key": "__convexAuthJWT" }`). */
  detail?: Record<string, string | number | boolean>;
  /** The nth line that matches from where the search starts; 1 by default. */
  nth?: number;
}

/** A pin: one line, or the span from one line to a later one. */
export type Pin = Match | { from: Match; to: Match };

/** A thing to look at in the world. */
export interface Look {
  /** The part's id (`module:browser/sessionManager`). */
  part: string;
  /** Open the part up, to see inside it. */
  open?: boolean;
  /** A member or a hold inside the part, by name, pointed to in words. */
  inside?: string;
}

/** A line that must, or must not, be in the operation of the stop's line. */
export interface Check {
  /** What the check says, in plain words. */
  say: string;
  has?: Match;
  not?: Match;
}

export interface StoryStop {
  say: string;
  pin?: Pin;
  look?: Look;
  checks?: Check[];
}

export interface Story {
  id: string;
  title: string;
  /** A line under the title in the list of stories. */
  about?: string;
  /** The control to press first: its action and its label. */
  press?: { action: string; label: string };
  stops: StoryStop[];
}

/** Whether something held in the run, did not, or has not arrived yet. */
export type Holds = "holds" | "missing" | "waiting";

export interface BoundCheck {
  check: Check;
  status: Holds;
  /** For `has`: the line found. For `not`: the line that should not be. */
  line?: PlayLine;
}

export interface BoundStop {
  stop: StoryStop;
  /** A note has no pin: it is said, never shown as having happened. */
  status: Holds | "note";
  /** The line it is pinned to (a span's first line). */
  line?: PlayLine;
  /** A span's last line. */
  to?: PlayLine;
  checks: BoundCheck[];
}

export interface BoundStory {
  story: Story;
  /** The section of the press, when the story asks for one and it came. */
  section: PlaySection | null;
  stops: BoundStop[];
}

const isSpan = (p: Pin): p is { from: Match; to: Match } =>
  "from" in p && "to" in p;

/** Whether a line is what `m` finds. */
export function matches(line: PlayLine, m: Match): boolean {
  if (m.op !== undefined && !(line.mark === "op" && line.opKind === m.op))
    return false;
  if (m.step !== undefined && line.step !== m.step) return false;
  if (m.who !== undefined && line.reporter !== m.who) return false;
  if (m.detail)
    for (const [k, v] of Object.entries(m.detail))
      if (line.detail?.[k] !== v) return false;
  return m.op !== undefined || m.step !== undefined || m.who !== undefined;
}

/** The lines in the order they happened: by time, then as the list reads. */
export function inOrder(lines: PlayLine[]): PlayLine[] {
  return lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => a.l.at - b.l.at || a.i - b.i)
    .map((x) => x.l);
}

/** The nth line after position `from` in `lines` that `m` finds, and where. */
function find(
  lines: PlayLine[],
  m: Match,
  from: number,
): { line: PlayLine; at: number } | null {
  let left = m.nth ?? 1;
  for (let i = from; i < lines.length; i++)
    if (matches(lines[i], m) && --left === 0) return { line: lines[i], at: i };
  return null;
}

/** The sections pressed with the label of a story's press, in order. */
export function pressSections(
  story: Story,
  sections: PlaySection[],
): PlaySection[] {
  if (!story.press) return [];
  const label = story.press.label.toLowerCase();
  return sections.filter(
    (s) => s.kind === "press" && s.title.toLowerCase() === label,
  );
}

/**
 * The section a story's press binds to: the newest one pressed with its
 * label, after the first `skip` (the presses there were before the viewer
 * pressed it from the story). Null while there is none.
 */
export function pressSection(
  story: Story,
  sections: PlaySection[],
  skip = 0,
): PlaySection | null {
  return pressSections(story, sections).slice(skip).at(-1) ?? null;
}

/**
 * Binds a story's stops to the lines of a run. Each pin is looked for after
 * the line of the stop before (a span's first line), so "the second init"
 * is the next one after the stop that found the first.
 *
 * `complete`: nothing more will be recorded of the lines the story looks at
 * (for a press: its end was recorded). Until then, what is not found is
 * waiting, not missing.
 */
export function bindStory(
  story: Story,
  sections: PlaySection[],
  opts: { skip?: number; complete?: boolean } = {},
): BoundStory {
  const section = story.press ? pressSection(story, sections, opts.skip) : null;
  const lines = inOrder(
    story.press ? (section?.lines ?? []) : allLines(sections),
  );
  const complete = story.press
    ? Boolean(section?.closed)
    : (opts.complete ?? true);
  const absent: Holds = complete ? "missing" : "waiting";
  let cursor = 0;
  const stops = story.stops.map((stop): BoundStop => {
    if (!stop.pin) return { stop, status: "note", checks: [] };
    const first = find(
      lines,
      isSpan(stop.pin) ? stop.pin.from : stop.pin,
      cursor,
    );
    if (!first)
      return {
        stop,
        status: absent,
        checks: (stop.checks ?? []).map((check) => ({ check, status: absent })),
      };
    cursor = first.at + 1;
    let to: PlayLine | undefined;
    if (isSpan(stop.pin)) {
      const last = find(lines, stop.pin.to, first.at + 1);
      if (!last)
        return {
          stop,
          status: absent,
          line: first.line,
          checks: (stop.checks ?? []).map((check) => ({
            check,
            status: absent,
          })),
        };
      to = last.line;
    }
    const checks = (stop.checks ?? []).map((check) =>
      checkOf(check, first.line, lines, complete),
    );
    return { stop, status: "holds", line: first.line, to, checks };
  });
  return { story, section, stops };
}

/** A check, in the operation of `line`. */
function checkOf(
  check: Check,
  line: PlayLine,
  lines: PlayLine[],
  complete: boolean,
): BoundCheck {
  const op = line.op;
  const of = op ? lines.filter((l) => l.op === op) : [line];
  if (check.has) {
    const found = of.find((l) => matches(l, check.has!));
    if (found) return { check, status: "holds", line: found };
    return { check, status: complete ? "missing" : "waiting" };
  }
  if (check.not) {
    const found = of.find((l) => matches(l, check.not!));
    if (found) return { check, status: "missing", line: found };
    // That something did not happen is known only once nothing more comes.
    return { check, status: complete ? "holds" : "waiting" };
  }
  return { check, status: "holds" };
}

/** Whether a bound stop and all its checks hold. */
export const stopHolds = (b: BoundStop) =>
  b.status === "holds" && b.checks.every((c) => c.status === "holds");

/** The time a stop takes the world to: its line's, just after it plays. */
export const stopTime = (b: BoundStop): number | null =>
  b.line ? b.line.at + 0.02 : null;

/**
 * Where "play to next" holds: the next stop's line, or the end of this
 * stop's span when the next has no line.
 */
export function playUntil(bound: BoundStop[], i: number): number | null {
  for (let j = i + 1; j < bound.length; j++) {
    const t = stopTime(bound[j]);
    if (t !== null) return t;
  }
  return bound[i].to ? bound[i].to.at + 0.02 : null;
}

/** Reads a story from its JSON, with what it must have; throws if not. */
export function readStory(json: unknown, name: string): Story {
  const s = json as Story;
  const fail = (why: string) => {
    throw new Error(`Story ${name}: ${why}.`);
  };
  if (typeof s?.id !== "string" || typeof s.title !== "string")
    fail("needs an id and a title");
  if (!Array.isArray(s.stops) || s.stops.length === 0) fail("has no stops");
  s.stops.forEach((stop, i) => {
    if (typeof stop?.say !== "string" || !stop.say.trim())
      fail(`stop ${i + 1} says nothing`);
    const ms = !stop.pin
      ? []
      : isSpan(stop.pin)
        ? [stop.pin.from, stop.pin.to]
        : [stop.pin];
    for (const c of stop.checks ?? []) {
      if (!stop.pin) fail(`stop ${i + 1} checks with no pin`);
      if (!c.has === !c.not) fail(`a check of stop ${i + 1} needs has or not`);
      ms.push((c.has ?? c.not)!);
    }
    for (const m of ms)
      if (m.op === undefined && m.step === undefined && m.who === undefined)
        fail(`stop ${i + 1} matches with nothing to match`);
  });
  return s;
}
