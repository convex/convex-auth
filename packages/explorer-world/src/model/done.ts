/**
 * What running code did in a recording, part by part: the steps each part
 * reported, at the places in its source that wrote them (when the project
 * says where its parts report), and who each part dealt with. Only the
 * recording counts: a part that reported nothing has done nothing here, and
 * no contact is drawn that the recording does not show.
 */
import { scalars, type ProjectInside } from "./inside.ts";
import type { GraphIndex, Link, Unresolved } from "./graph.ts";
import type { PageItem, Recording } from "./recording.ts";
import type { Timeline } from "./schedule.ts";

/** One reported step, in shown time. */
export interface Hit {
  at: number;
  step: string;
  /** The part whose code ran: the site's part when known, else the part it reported as. */
  part: string;
  /** The sites that can have written it: one, or several the recording cannot tell apart. */
  sites: string[];
}

/** Two parts that dealt with each other at a moment, as the recording shows. */
export interface Contact {
  at: number;
  a: string;
  b: string;
  /** How: a movement's kind (`call`, `request`…), `step` for a step that named a key, `op` for an operation of the client moving on. */
  how: string;
}

export interface Done {
  /** By part, in shown time. */
  hits: Map<string, Hit[]>;
  contacts: Contact[];
}

const order = (it: PageItem) => it.order?.seq ?? 0;

/**
 * The client steps of the timeline are the page's step items, played; a
 * step's shown time is that of its item. They are paired by part and name
 * in the order they happened (the k-th `token.fetch` of a module is its
 * k-th item).
 */
function clientItems(recording: Recording, timeline: Timeline) {
  const seen = new Set<PageItem>();
  const items: PageItem[] = [];
  // What the page reported before any run (on load) counts too.
  for (const it of recording.early ?? [])
    if (it.step && !seen.has(it)) {
      seen.add(it);
      items.push(it);
    }
  for (const r of recording.runs)
    for (const it of [...r.before, ...r.after])
      if (it.step && !seen.has(it)) {
        seen.add(it);
        items.push(it);
      }
  items.sort((x, y) => x.time - y.time || order(x) - order(y));
  const queue = new Map<string, PageItem[]>();
  for (const it of items) {
    const key = `${it.part}|${it.step}`;
    queue.set(key, [...(queue.get(key) ?? []), it]);
  }
  const out: { item: PageItem; at: number }[] = [];
  const steps = [...timeline.clientSteps].sort((x, y) => x.start - y.start);
  for (const s of steps) {
    const item = queue.get(`${s.part}|${s.step}`)?.shift();
    if (item) out.push({ item, at: s.start });
  }
  return out;
}

export function doneIn(
  recording: Recording,
  timeline: Timeline,
  inside: ProjectInside | undefined,
): Done {
  const hits = new Map<string, Hit[]>();
  const add = (h: Hit) => hits.set(h.part, [...(hits.get(h.part) ?? []), h]);
  const contacts: Contact[] = [];
  const origin = (report: PageItem["report"], fallback: string) => {
    const found = report && inside ? inside.sitesOf(report) : [];
    const parts = new Set(found.map((f) => f.part));
    const part = parts.size === 1 && [...parts][0] ? [...parts][0]! : fallback;
    return { part, sites: found.map((f) => f.site) };
  };

  for (const { item, at } of clientItems(recording, timeline)) {
    const { part, sites } = origin(item.report, item.part);
    add({ at, step: item.step!, part, sites });
    // A step that names a key deals with it.
    for (const other of item.lights ?? [])
      if (other !== item.part)
        contacts.push({ at, a: part, b: other, how: "step" });
  }

  // A server step is counted once its run is over.
  for (const c of timeline.chapters)
    for (const s of c.run.steps) {
      if (s.kind !== "note") continue;
      const { part, sites } = origin(
        { step: s.name, detail: scalars(s.detail) },
        c.run.function,
      );
      add({ at: c.end, step: s.name, part, sites });
    }

  for (const m of timeline.movements)
    if (m.from !== m.to)
      contacts.push({ at: m.start, a: m.from, b: m.to, how: m.kind });
  for (const o of timeline.ops)
    for (let i = 1; i < o.points.length; i++) {
      const a = o.points[i - 1].anchor;
      const b = o.points[i].anchor;
      if (a !== b) contacts.push({ at: o.points[i].at, a, b, how: "op" });
    }
  for (const list of hits.values()) list.sort((x, y) => x.at - y.at);
  contacts.sort((x, y) => x.at - y.at);
  return { hits, contacts };
}

/** What a part has done by shown time `t`. */
export interface DoneSoFar {
  hits: Hit[];
  /** The sites reported so far (a hit that could be one of several counts each of them as maybe). */
  sites: Set<string>;
  /** How many of its sites have reported: the sure ones, and one for each step that could be one of several. */
  count: number;
  latest?: Hit;
}

export function doneBy(done: Done, part: string, t: number): DoneSoFar {
  const hits = (done.hits.get(part) ?? []).filter((h) => h.at <= t);
  const sites = new Set<string>();
  for (const h of hits) if (h.sites.length === 1) sites.add(h.sites[0]);
  // A step that may be one of several sites counts once, unless one of
  // them is already counted.
  const maybe = new Set<string>();
  for (const h of hits)
    if (h.sites.length > 1 && !h.sites.some((x) => sites.has(x)))
      maybe.add(h.sites.join("|"));
  return {
    hits,
    sites,
    count: sites.size + maybe.size,
    latest: hits[hits.length - 1],
  };
}

/**
 * Who the parts in `covered` dealt with by shown time `t`, outside
 * `covered`: each other part once, with how often and when last.
 */
export function contactsOf(
  done: Done,
  covered: Set<string>,
  t: number,
): { other: string; from: string; n: number; last: number; how: string }[] {
  const by = new Map<
    string,
    { other: string; from: string; n: number; last: number; how: string }
  >();
  for (const c of done.contacts) {
    if (c.at > t) break;
    const inA = covered.has(c.a);
    const inB = covered.has(c.b);
    if (inA === inB) continue;
    const from = inA ? c.a : c.b;
    const other = inA ? c.b : c.a;
    const key = `${from}|${other}`;
    const was = by.get(key);
    if (was) {
      was.n++;
      was.last = c.at;
      was.how = c.how;
    } else by.set(key, { other, from, n: 1, last: c.at, how: c.how });
  }
  return [...by.values()].sort((x, y) => y.last - x.last);
}

/**
 * What a selected part lights, besides itself. By default, who it dealt
 * with so far, as recorded: nothing it did not deal with. With the detail
 * asked for, the links of the source too (every link that touches it, both
 * ways) and the unresolved ones.
 */
export function lighting(
  index: GraphIndex,
  done: Done,
  covered: Set<string>,
  t: number,
  detail: boolean,
): {
  /** The other end of each link lit, by its kind, or by how the recording shows them deal. */
  linked: Map<string, string>;
  links: Link[];
  contacts: ReturnType<typeof contactsOf>;
  unresolved: Unresolved[];
} {
  const contacts = contactsOf(done, covered, t);
  const linked = new Map<string, string>();
  const links: Link[] = [];
  const unresolved = new Set<Unresolved>();
  if (!detail) {
    for (const c of contacts)
      if (!linked.has(c.other)) linked.set(c.other, c.how);
    return { linked, links, contacts, unresolved: [] };
  }
  const seen = new Set<string>();
  for (const id of covered) {
    for (const l of [
      ...(index.out.get(id) ?? []),
      ...(index.in.get(id) ?? []),
    ]) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      links.push(l);
      for (const end of [l.from, l.to])
        if (!covered.has(end) && !linked.has(end)) linked.set(end, l.kind);
    }
    for (const u of index.unresolvedFrom.get(id) ?? []) unresolved.add(u);
  }
  return { linked, links, contacts, unresolved: [...unresolved] };
}
