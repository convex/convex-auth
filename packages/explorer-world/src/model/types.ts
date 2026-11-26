/**
 * The model of the world: what exists (the structure) and what happened (the
 * recording). The engine, the scene and the UI only see these types, and they
 * know nothing of any one codebase: a project supplies its structure and
 * recording through an adapter, and its look through a `ProjectConfig`.
 */

/**
 * The role a region plays in the world:
 *
 * - `client`: outside the system. It calls in and holds tokens.
 * - `platform`: what the services run on. Drawn as the floor under them.
 * - `service`: code and data inside the system. Drawn as an island.
 */
export type RegionKind = "client" | "platform" | "service";

export interface Region {
  id: string;
  kind: RegionKind;
  label: string;
  /** A word for what it is, shown under its name (for example "component"). */
  tag?: string;
  parent?: string;
  package?: string;
  summary: string;
}

/**
 * A fixed place of the platform that things travel to:
 *
 * - `entry`: where requests from clients enter; they pass through it.
 * - `issuer`: where tokens are issued (signed).
 * - `scheduler`: what runs scheduled functions.
 */
export interface Place {
  id: string;
  role: "entry" | "issuer" | "scheduler";
  region: string;
  label: string;
  /** One line under the label. */
  caption?: string;
  summary: string;
}

export interface FunctionDef {
  id: string;
  region: string;
  /** The full name, as the codebase knows it. */
  name: string;
  /** A short name for the label on the function itself. */
  short: string;
  /** A name that reads on its own in a sentence, region included. */
  label: string;
  type: "query" | "mutation" | "action";
  visibility: string;
  scheduled: boolean;
  summary: string;
}

export interface TableDef {
  id: string;
  region: string;
  name: string;
  fields: string[];
  summary: string;
  /** The field whose value is the lifecycle state of a row, if any. */
  stateField?: string;
}

/** A kind of token that travels and is held, such as an access token. */
export interface TokenKind {
  kind: string;
  label: string;
  summary: string;
}

export interface Structure {
  regions: Region[];
  places: Place[];
  functions: FunctionDef[];
  tables: TableDef[];
  tokens: TokenKind[];
}

export type Doc = Record<string, string | number | boolean | null>;

export interface TokenRef {
  kind: string;
  label: string;
  /** The row that stores this token, if a table does. */
  table?: string;
  row?: string;
}

export type Tone = "normal" | "warn" | "error";

/** What happened inside one function run, in order. */
export type Step =
  | { kind: "start"; label?: string }
  | { kind: "call"; target: string }
  | { kind: "return"; target: string; value?: string; tone: Tone }
  | {
      /** A token issued at a place, such as a signed access token. */
      kind: "issue";
      place: string;
      text: string;
      token?: TokenRef;
    }
  | {
      kind: "log";
      level: "info" | "warn" | "error";
      region: string;
      message: string;
    }
  | { kind: "result"; status: string; error?: string; tone: Tone };

export interface Write {
  table: string;
  op: "insert" | "patch" | "delete";
  row: string;
  label?: string;
  doc: Doc;
}

/** One function run of the recording. Its writes commit together at its end. */
export interface Execution {
  id: string;
  title: string;
  function: string;
  /**
   * The region that started the run, or for a scheduled run the scheduler
   * place.
   */
  caller: string;
  scheduled: boolean;
  /** The place the request passes on its way in, if any. */
  entry?: string;
  startedAt: number;
  endedAt: number;
  args: Doc;
  presents?: TokenRef;
  steps: Step[];
  writes: Write[];
  schedules: string[];
  status: string | null;
  error?: string;
  tone: Tone;
  /** Tokens the response gives the caller. */
  tokens: TokenRef[];
  /** Tokens the caller loses when the response arrives. */
  drops: TokenRef[];
}

export interface Recording {
  executions: Execution[];
}
