/**
 * Maps a structure model of a Convex project (`@convex-dev/explorer-structure`)
 * to the graph of the world. Generic: it reads the part and dependency kinds
 * from the data and copies every other field of a part into its facts.
 */
import type { Graph, Part } from "../model/graph.ts";
import {
  fill,
  kindLook,
  partValues,
  type Presentation,
} from "../presentation.ts";

/** The shape of a structure model this adapter reads (any version-2 model). */
export interface StructureInput {
  version: number;
  project: string;
  parts: ({
    id: string;
    kind: string;
    name: string;
    parent: string | null;
    source: { file: string; line: number } | null;
  } & Record<string, unknown>)[];
  dependencies: {
    kind: string;
    from: string;
    to: string;
    evidence: { file: string; line: number }[];
    via?: string[];
    app?: string;
  }[];
  unresolved: {
    kind: string;
    from: string[];
    location: { file: string; line: number };
    code: string;
    reason: string;
  }[];
}

export const SUPPORTED_STRUCTURE_VERSIONS = [2];

const OWN = new Set(["id", "kind", "name", "parent", "source", "fields"]);

function factValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined;
    return v
      .map((x) =>
        typeof x === "object" && x
          ? "name" in x
            ? `${String((x as { name: unknown }).name)}${"fields" in x ? `(${String((x as { fields: unknown[] }).fields)})` : ""}`
            : JSON.stringify(x)
          : String(x),
      )
      .join(", ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function graphFromStructure(
  input: StructureInput,
  presentation: Presentation,
): Graph {
  if (!SUPPORTED_STRUCTURE_VERSIONS.includes(input.version)) {
    throw new Error(
      `Structure version ${input.version} is not one this world reads (${SUPPORTED_STRUCTURE_VERSIONS.join(", ")}).`,
    );
  }
  const parts: Part[] = input.parts.map((p) => {
    const facts: [string, string][] = [];
    for (const [k, v] of Object.entries(p)) {
      if (OWN.has(k)) continue;
      const value = factValue(v);
      if (value !== undefined) facts.push([k, value]);
    }
    const part: Part = {
      id: p.id,
      kind: p.kind,
      name: p.name,
      label: p.name,
      parent: p.parent,
      source: p.source,
      facts,
      fields: Array.isArray(p.fields)
        ? (p.fields as Part["fields"])
        : undefined,
    };
    const template =
      presentation.parts?.[p.id]?.label ?? kindLook(presentation, p.kind).label;
    if (template) part.label = fill(template, partValues(part)) || p.name;
    return part;
  });
  const counts = new Map<string, number>();
  const links = input.dependencies.map((d) => {
    const key = `${d.kind}:${d.from}->${d.to}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return {
      id: n ? `${key}#${n}` : key,
      kind: d.kind,
      from: d.from,
      to: d.to,
      evidence: d.evidence,
      via: d.via,
      scope: d.app,
    };
  });
  const unresolved = input.unresolved.map((u, i) => ({
    id: `unresolved:${i}`,
    kind: u.kind,
    from: u.from,
    location: u.location,
    code: u.code,
    reason: u.reason,
  }));
  return { project: input.project, parts, links, unresolved };
}
