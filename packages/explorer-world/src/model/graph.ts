/**
 * What exists: every part of a system and every dependency between parts, in
 * neutral terms. An adapter builds it from a structure map; the layout, the
 * scene and the UI read only this. A part's `kind` and a link's `kind` are
 * whatever the data says; the presentation (see `presentation.ts`) says how
 * each kind looks.
 */

/** A place in the source: a path from the repository root and a 1-based line. */
export interface SourceRef {
  file: string;
  line: number;
}

export interface Field {
  name: string;
  type: string;
  optional: boolean;
}

export interface Part {
  id: string;
  kind: string;
  name: string;
  /** The text on the part in the world. */
  label: string;
  /** The id of the enclosing part, `null` at the top. */
  parent: string | null;
  source: SourceRef | null;
  /** The other facts the data gives about the part, for the inspector. */
  facts: [name: string, value: string][];
  /** The fields of a table. */
  fields?: Field[];
  /**
   * Not in the structure map: the recording shows it (a caller, a table of a
   * component from npm). Says why it is here.
   */
  observed?: string;
}

/** A dependency between two parts, with the places in the source that show it. */
export interface Link {
  id: string;
  kind: string;
  from: string;
  to: string;
  evidence: SourceRef[];
  /** How, where it varies: a method, a library function, a host. */
  via?: string[];
  /** The context it holds in only, if any (an app that passes a reference). */
  scope?: string;
}

/** A dependency the structure map found but could not resolve. */
export interface Unresolved {
  id: string;
  kind: string;
  /** The parts whose code reaches it. */
  from: string[];
  location: SourceRef;
  code: string;
  reason: string;
}

export interface Graph {
  /** The name of the project the data describes. */
  project: string;
  parts: Part[];
  links: Link[];
  unresolved: Unresolved[];
}

/** Lookups over a graph, built once. */
export interface GraphIndex {
  graph: Graph;
  part: Map<string, Part>;
  children: Map<string, Part[]>;
  /** Links by the part they leave and the part they reach. */
  out: Map<string, Link[]>;
  in: Map<string, Link[]>;
  unresolvedFrom: Map<string, Unresolved[]>;
}

export function indexGraph(graph: Graph): GraphIndex {
  const part = new Map(graph.parts.map((p) => [p.id, p]));
  const children = new Map<string, Part[]>();
  for (const p of graph.parts) {
    if (!p.parent) continue;
    const list = children.get(p.parent) ?? [];
    list.push(p);
    children.set(p.parent, list);
  }
  const out = new Map<string, Link[]>();
  const into = new Map<string, Link[]>();
  for (const l of graph.links) {
    out.set(l.from, [...(out.get(l.from) ?? []), l]);
    into.set(l.to, [...(into.get(l.to) ?? []), l]);
  }
  const unresolvedFrom = new Map<string, Unresolved[]>();
  for (const u of graph.unresolved) {
    for (const from of u.from) {
      unresolvedFrom.set(from, [...(unresolvedFrom.get(from) ?? []), u]);
    }
  }
  return { graph, part, children, out, in: into, unresolvedFrom };
}

/** The chain of parents of a part, nearest first. */
export function ancestors(index: GraphIndex, id: string): Part[] {
  const chain: Part[] = [];
  const seen = new Set<string>();
  let p = index.part.get(id);
  while (p?.parent && !seen.has(p.parent)) {
    seen.add(p.parent);
    const parent = index.part.get(p.parent);
    if (!parent) break;
    chain.push(parent);
    p = parent;
  }
  return chain;
}

/** The value of a fact of a part, if it has it. */
export function fact(part: Part, name: string): string | undefined {
  return part.facts.find(([n]) => n === name)?.[1];
}
