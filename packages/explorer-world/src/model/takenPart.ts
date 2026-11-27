/**
 * Which groups of parts (see `Cluster` in `layout/types.ts`) and which of
 * their parts have taken part so far, and on what evidence. Nothing here is
 * guessed: a part took part when running code reported it (a step it
 * reported, a run of it); a group took part when one of its parts did, or
 * when the page called a function that the structure links to the group's
 * owner (a `signIn.call` naming the app's function that a sign-in method
 * defines). Apart from what ran, a group is *wired* when the structure
 * shows a link from the app the recording ran in (`presentation.focus`) to
 * its owner: what the app is set up to use, from its source.
 */
import type { Cluster, Layout } from "../layout/types.ts";
import { ancestors, type GraphIndex, type Link } from "./graph.ts";
import type { Timeline } from "./schedule.ts";

export interface Evidence {
  /** Shown time of the first evidence. */
  at: number;
  /** "reported": a part of the group reported; "called": the page called a function linked to it. */
  how: "reported" | "called";
  /** The part that reported, or the function called. */
  part: string;
}

export interface TakenPart {
  /** Per group id: the first evidence that it took part. */
  groups: Map<string, Evidence>;
  /** Per part in a group: when it first reported (shown time). */
  parts: Map<string, number>;
  /** Per group id: the link from the focus app to its owner, if any. */
  wired: Map<string, Link>;
  /** Per part in a group: its group. */
  groupOf: Map<string, Cluster>;
}

export function takenPart(
  index: GraphIndex,
  layout: Layout,
  timeline: Timeline,
  focus: string | undefined,
): TakenPart {
  const groupOf = new Map<string, Cluster>();
  const byOwner = new Map<string, Cluster>();
  for (const island of layout.islands)
    for (const c of island.clusters) {
      for (const m of c.members) groupOf.set(m, c);
      // A group by directory is not the whole of what its owner holds.
      if (c.id === c.owner) byOwner.set(c.owner, c);
    }
  const groups = new Map<string, Evidence>();
  const parts = new Map<string, number>();
  const note = (c: Cluster, e: Evidence) => {
    const was = groups.get(c.id);
    if (!was || e.at < was.at) groups.set(c.id, e);
  };
  for (const a of timeline.activations) {
    const c = groupOf.get(a.node);
    if (!c) continue;
    const was = parts.get(a.node);
    if (was === undefined || a.start < was) parts.set(a.node, a.start);
    note(c, { at: a.start, how: "reported", part: a.node });
  }

  const inFocus = (id: string) =>
    !!focus &&
    (id === focus || ancestors(index, id).some((p) => p.id === focus));
  // The parts a reported function name (`auth:signIn`) may be: of the app
  // the recording ran in when it has one.
  const fnParts = new Map<string, string[]>();
  const partsOf = (fn: string) => {
    let found = fnParts.get(fn);
    if (!found) {
      const end = `:${fn.replace(":", ".")}`;
      const all = [...index.part.keys()].filter((id) => id.endsWith(end));
      const own = all.filter(inFocus);
      found = own.length ? own : all;
      fnParts.set(fn, found);
    }
    return found;
  };
  for (const s of timeline.clientSteps) {
    if (!s.fn) continue;
    for (const f of partsOf(s.fn))
      for (const l of index.out.get(f) ?? [])
        for (const id of [l.to, ...ancestors(index, l.to).map((p) => p.id)]) {
          const c = byOwner.get(id);
          if (c) note(c, { at: s.start, how: "called", part: f });
        }
  }

  const wired = new Map<string, Link>();
  if (focus)
    for (const [owner, c] of byOwner)
      for (const l of index.in.get(owner) ?? [])
        if (inFocus(l.from) && !wired.has(c.id)) wired.set(c.id, l);
  return { groups, parts, wired, groupOf };
}
