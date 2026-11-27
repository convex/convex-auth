/**
 * What a selection lights: the parts it covers, and the parts they dealt
 * with so far in the recording. With the detail asked for (`detail` in the
 * store), the links of the source too: every link that touches them, the
 * parts at the other end, and the unresolved ones.
 */
import type { Link, Unresolved } from "../model/graph.ts";
import { lighting, type contactsOf } from "../model/done.ts";
import { done } from "../insides.ts";
import { usePlayback, world, type Selection } from "../store.ts";
import { coverage } from "./look.ts";

export interface Highlight {
  /** The selected part, when a part is selected. */
  part: string | null;
  /** Whether that part is an island: its parts are covered but not singled out. */
  island: boolean;
  covered: Set<string>;
  /**
   * The other end of each link lit, by its kind: a link of the source with
   * the detail asked for, else how the recording shows them deal (`call`,
   * `request`, `step`…).
   */
  linked: Map<string, string>;
  /** The links of the source, only with the detail asked for. */
  links: Link[];
  /** Who the covered parts dealt with by now, as recorded. */
  contacts: ReturnType<typeof contactsOf>;
  unresolved: Unresolved[];
}

const EMPTY: Highlight = {
  part: null,
  island: false,
  covered: new Set(),
  linked: new Map(),
  links: [],
  contacts: [],
  unresolved: [],
};

let memo: {
  key: string;
  timeline: typeof world.timeline;
  value: Highlight;
} | null = null;

export function highlightOf(s: Selection | null): Highlight {
  if (!s) return EMPTY;
  const { detail, time } = usePlayback.getState();
  const key = `${JSON.stringify(s)}|${detail}|${time}`;
  if (memo?.key === key && memo.timeline === world.timeline) return memo.value;
  let covered: Set<string>;
  switch (s.type) {
    case "part":
      covered = coverage(s.id);
      break;
    case "row":
      covered = new Set([s.table]);
      break;
    case "cargo":
      covered = new Set([s.holder, s.table]);
      break;
    case "movement": {
      const m = world.timeline.movements.find((x) => x.id === s.id);
      covered = new Set(m ? [m.from, m.to] : []);
      break;
    }
    case "run": {
      const r = world.recording.runs.find((x) => x.id === s.id);
      covered = new Set(
        r
          ? [
              r.function,
              r.caller,
              ...r.steps.flatMap((x) => (x.kind === "call" ? [x.target] : [])),
              ...r.writes.map((w) => w.table),
            ]
          : [],
      );
      break;
    }
    case "op": {
      const o = world.timeline.ops.find((x) => x.id === s.id);
      covered = new Set(o?.points.map((p) => p.anchor) ?? []);
      break;
    }
  }
  const lit =
    s.type === "part"
      ? lighting(world.index, done(), covered, time, detail)
      : {
          linked: new Map<string, string>(),
          links: [],
          contacts: [],
          unresolved: [],
        };
  const part = s.type === "part" ? s.id : null;
  const value = {
    part,
    island: part !== null && covered.size > 1,
    covered,
    ...lit,
  };
  memo = { key, timeline: world.timeline, value };
  return value;
}
