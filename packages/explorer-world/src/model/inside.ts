/**
 * The inside of a part, in neutral terms: what it exports (and the members
 * of what it exports), what it holds, and the places in its code that
 * report steps. A project builds it from its own data (Convex Auth's comes
 * from the structure map's `modules`, `steps` and `holds`); the world only
 * reads it. Every text here is copied from the source; the world never
 * writes a description of its own.
 */

/** Something a part exports, or a member of something it exports. */
export interface Place {
  /** Unique within the part: the export's name, `Export.member` for a member. */
  id: string;
  name: string;
  /** As the data says it: `function`, `class`, `const`, `method`, `type`… */
  kind: string;
  /** The first sentence of its own doc comment, copied from the source. */
  summary?: string;
  line?: number;
  /** The place it is a member of. */
  of?: string;
  /** The part it is, when it is drawn as a part of its own (a hook). */
  part?: string;
  /** Re-exported from elsewhere: where. */
  from?: string;
  /** Only names a type: it does nothing at run time. */
  typeOnly?: boolean;
}

/** Something a part holds: a stored key, a lock, a piece of state. */
export interface Holding {
  kind: "key" | "lock" | "state";
  name: string;
  /** For a key: how it is used (`get`, `set`…). For a lock: the key it is named after. */
  detail?: string;
  /** The place it belongs to (a field of a class), if known. */
  place?: string;
}

/** A place in a part's code that reports a step. */
export interface Site {
  /** Unique across the project. */
  id: string;
  /** The name of the step it reports. */
  step: string;
  /** The place it sits in, else `null` (code the part does not export). */
  place: string | null;
  line: number;
  file: string;
}

export interface PartInside {
  /**
   * One line about the part in the source's own words, and, when it is not
   * the part's own (a module with no doc comment), the export it is from.
   */
  summary?: { text: string; from?: string };
  places: Place[];
  holds: Holding[];
  sites: Site[];
}

/** A step as running code reported it, for finding the site that wrote it. */
export interface Report {
  step: string;
  /** Where it ran: `browser` for a client step; absent on the server. */
  runsIn?: string;
  /** The part it reported as, when it named one. */
  part?: string;
  /** The scalar values of its detail (never a secret: those are objects). */
  detail?: Record<string, string | number | boolean | null>;
}

/** What a project says of the insides of its parts. */
export interface ProjectInside {
  parts: Record<string, PartInside>;
  /** The sites that can have written a report: one, several the data cannot tell apart, or none. */
  sitesOf: (report: Report) => { site: string; part: string | null }[];
}

/** The scalar values of a step's detail, the only ones a report keeps. */
export function scalars(
  detail: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!detail) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(detail))
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    )
      out[k] = v;
  return out;
}
