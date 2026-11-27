/**
 * How the parts of a project look and read: what the data cannot know. It is
 * data (JSON), kept with the project, never in the renderer. A project's
 * presentation extends a preset (`presets/convex.json` for any Convex
 * project) and adds what only it has: its own part kinds, the state field of
 * a table, how to depict the rows a request carries, one-line descriptions.
 */
import type { Bracket } from "./model/operations.ts";
import type { Part } from "./model/graph.ts";
import type { Tone } from "./model/recording.ts";

/** The shapes the world can draw. A kind of part picks one. */
import type { PageState } from "./model/recording.ts";

export type Shape =
  | "island"
  | "pillar"
  | "vault"
  | "post"
  | "gate"
  | "beacon"
  | "shard"
  | "obelisk"
  | "marker"
  /** A page's sign-in state: drawn by the scene from the state it is in. */
  | "state";

/** The variants of a pillar. */
export type Profile = "round" | "hex" | "square" | "tri";

/** Where an island floats: outside the system, on the platform, or beyond it. */
export type Zone = "client" | "platform" | "external";

export interface KindLook {
  shape: Shape;
  /** A noun for one part of the kind, e.g. "function". */
  noun: string;
  /** The plural, if not the noun plus "s". */
  plural?: string;
  /** An accent color. Islands without one take one from the palette. */
  color?: string;
  /** For islands: where they float. */
  zone?: Zone;
  /** A fact whose value picks the profile of a pillar, e.g. `functionType`. */
  profileBy?: string;
  profiles?: Record<string, Profile>;
  /**
   * Re-homes a part: a template over its facts naming the part it is drawn
   * in, e.g. `region:{runsIn}`. The structural parent stays in the data.
   */
  placeIn?: string;
  /** A template over the part's name and facts for its label, e.g. `{method} {path}`. */
  label?: string;
  /** Larger parts get more room; 1 is the default. */
  size?: number;
  /**
   * Where along the way through an island a part stands, from the outside
   * (0, where a person acts) to the way out (higher). An island with members
   * that have one lays them out in columns by it, left to right, toward the
   * platform; the members without one share the column after the last.
   */
  flow?: number;
}

export interface LinkLook {
  /** A verb phrase, e.g. "calls". */
  verb: string;
  /** Read backwards, e.g. "is called by". */
  inverse: string;
  color: string;
}

export interface StateLook {
  color: string;
  /** A retired row is drawn dimmed and tilted. */
  retired?: boolean;
}

export interface TableLook {
  /** The field whose value is the lifecycle state of a row. */
  stateField?: string;
  states?: Record<string, StateLook>;
  /** A template over the row's fields for a second line on its card. */
  caption?: string;
  /** A template over the row's fields for its title, e.g. `{username}`. */
  title?: string;
}

/**
 * Says that the rows of a table travel: a response carries the rows its run
 * inserted, a request carries the rows whose field its run moved away from a
 * value (a token it redeemed). The recording does not record arguments or
 * return values, so cargo is always derived.
 */
export interface CargoRule {
  table: string;
  /** For a recording of a page: the type of secret the rule names (`jwt`, `opaque`). */
  secretType?: string;
  /** A noun for one row as cargo, e.g. "refresh token". */
  noun: string;
  shape: "key" | "coin" | "card";
  color: string;
  /** The response of a run carries the rows it inserted into the table. */
  out?: "inserted";
  /** The request of a run carries the rows whose `field` it changed from `from`. */
  in?: { field: string; from: string };
}

export interface StepLook {
  /** A template over the step's detail, e.g. `issues a session to {userId}`. */
  text?: string;
  /** Picks the tone from a field of the detail. */
  toneBy?: { field: string; tones: Record<string, Tone> };
  /** The detail field that is the step's outcome, used as the run's status. */
  statusField?: string;
}

export interface Presentation {
  /** The name of a preset under `presets/` that this one extends. */
  extends?: string;
  title: string;
  subtitle?: string;
  /** Accent colors handed to islands in order. */
  palette?: string[];
  kinds: Record<string, KindLook>;
  links: Record<string, LinkLook>;
  /** Per part id: what only it has. */
  parts?: Record<
    string,
    {
      color?: string;
      zone?: Zone;
      summary?: string;
      label?: string;
      /** For a region: the name of the district its client code stands in. */
      library?: string;
    }
  >;
  /** Per table part id. */
  tables?: Record<string, TableLook>;
  cargo?: CargoRule[];
  /** Per step-report name. */
  steps?: Record<string, StepLook>;
  /** Per caller as the recording names it: a label and a one-line summary. */
  callers?: Record<string, { label?: string; summary?: string }>;
  /** The part a recorded page runs in, e.g. the region of the browser. */
  client?: string;
  /**
   * How the steps a page's client library reports set its sign-in state: the
   * first rule whose step is the step reported and whose `when` fields equal
   * those of its detail.
   */
  pageStates?: {
    step: string;
    when?: Record<string, unknown>;
    state: PageState;
  }[];
  /**
   * The brackets an operation of the client makes its call in (see
   * `model/operations.ts`): the one call between an operation's opening and
   * closing step is its call, marked as matched by bracket.
   */
  brackets?: Bracket[];
  /** The id of the part the recording ran in (the app being replayed). */
  focus?: string;
  /**
   * The kinds of island named at rest. An island of another kind, outside
   * the client's region, is named once running code reaches it, else only
   * close in and on hover. Without it every island is named.
   */
  namedAtRest?: string[];
  /** The name of the layout strategy (see `src/layout/index.ts`); "islands" by default. */
  layout?: string;
}

/** Merges a project's presentation over the preset it extends. */
export function extendPresentation(
  base: Presentation,
  own: Presentation,
): Presentation {
  return {
    ...base,
    ...own,
    palette: own.palette ?? base.palette,
    kinds: { ...base.kinds, ...own.kinds },
    links: { ...base.links, ...own.links },
    parts: { ...base.parts, ...own.parts },
    tables: { ...base.tables, ...own.tables },
    cargo: [...(base.cargo ?? []), ...(own.cargo ?? [])],
    steps: { ...base.steps, ...own.steps },
    callers: { ...base.callers, ...own.callers },
  };
}

const FALLBACK_KIND: KindLook = { shape: "marker", noun: "part" };
const FALLBACK_LINK: LinkLook = {
  verb: "depends on",
  inverse: "is depended on by",
  color: "#9aa7c7",
};
const FALLBACK_PALETTE = [
  "#6aa8ff",
  "#3fe0d0",
  "#ffb454",
  "#7ee081",
  "#b48cff",
  "#ff7a45",
  "#ff4f7b",
  "#5ad1ff",
  "#e6d36b",
];

export function kindLook(p: Presentation, kind: string): KindLook {
  return p.kinds[kind] ?? FALLBACK_KIND;
}

export function linkLook(p: Presentation, kind: string): LinkLook {
  return p.links[kind] ?? { ...FALLBACK_LINK, verb: kind };
}

export function nounOf(p: Presentation, kind: string, n = 1): string {
  const look = p.kinds[kind];
  if (!look) return n === 1 ? kind : `${kind}s`;
  return n === 1 ? look.noun : (look.plural ?? `${look.noun}s`);
}

/** Fills `{name}` holes from a record; a hole with no value stays empty. */
export function fill(
  template: string,
  values: Record<string, unknown>,
): string {
  return template
    .replace(/\{(\w+)\}/g, (_, k: string) =>
      values[k] === undefined || values[k] === null ? "" : String(values[k]),
    )
    .trim();
}

export function partValues(part: Part): Record<string, unknown> {
  return { ...Object.fromEntries(part.facts), name: part.name, id: part.id };
}

/** A stable color from the palette for an id. */
export function paletteColor(p: Presentation, i: number): string {
  const palette = p.palette?.length ? p.palette : FALLBACK_PALETTE;
  return palette[((i % palette.length) + palette.length) % palette.length];
}
