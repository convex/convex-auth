/**
 * What a selection lights: the parts it covers, the links that touch them,
 * and the parts at the other end of those links.
 */
import type { Link, Unresolved } from "../model/graph.ts";
import { world, type Selection } from "../store.ts";
import { coverage } from "./look.ts";

export interface Highlight {
  /** The selected part, when a part is selected. */
  part: string | null;
  /** Whether that part is an island: its parts are covered but not singled out. */
  island: boolean;
  covered: Set<string>;
  /** The other end of each link, by the kind of the link that reaches it. */
  linked: Map<string, string>;
  links: Link[];
  unresolved: Unresolved[];
}

const EMPTY: Highlight = {
  part: null,
  island: false,
  covered: new Set(),
  linked: new Map(),
  links: [],
  unresolved: [],
};

let memo: { key: string; value: Highlight } | null = null;

export function highlightOf(s: Selection | null): Highlight {
  if (!s) return EMPTY;
  const key = JSON.stringify(s);
  if (memo?.key === key) return memo.value;
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
  }
  const links: Link[] = [];
  const linked = new Map<string, string>();
  const unresolved: Unresolved[] = [];
  // Only a part's own selection lights its links; a run lights its parts.
  if (s.type === "part") {
    const seen = new Set<string>();
    for (const id of covered) {
      for (const l of [
        ...(world.index.out.get(id) ?? []),
        ...(world.index.in.get(id) ?? []),
      ]) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        links.push(l);
        for (const end of [l.from, l.to])
          if (!covered.has(end) && !linked.has(end)) linked.set(end, l.kind);
      }
      unresolved.push(...(world.index.unresolvedFrom.get(id) ?? []));
    }
  }
  const part = s.type === "part" ? s.id : null;
  const value = {
    part,
    island: part !== null && covered.size > 1,
    covered,
    linked,
    links,
    unresolved: [...new Set(unresolved)],
  };
  memo = { key, value };
  return value;
}
