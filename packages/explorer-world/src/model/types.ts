/**
 * The model of the world: what exists (the structure) and what happened (the
 * recording). The scene and the UI only see these types. The adapter turns
 * the data files into them, so a change of data format stays in the adapter.
 */

export type RegionKind = "client" | "platform" | "app" | "component";

export interface Region {
  id: string;
  kind: RegionKind;
  label: string;
  parent?: string;
  package?: string;
  summary: string;
}

export interface FunctionDef {
  id: string;
  region: string;
  name: string;
  type: "query" | "mutation" | "action";
  visibility: "public" | "internal" | "component";
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

export interface Structure {
  regions: Region[];
  functions: FunctionDef[];
  tables: TableDef[];
}

export type Doc = Record<string, string | number | boolean | null>;

export interface TokenRef {
  kind: "access" | "refresh";
  label: string;
  /** The row of `refreshTokens` that stores this token's hash. */
  row?: string;
}

/** What happened inside one function run, in order. */
export type Step =
  | { kind: "start" }
  | { kind: "call"; target: string }
  | { kind: "return"; target: string; value?: string }
  | { kind: "sessionIssued"; session?: string }
  | {
      kind: "log";
      level: "info" | "warn" | "error";
      region: string;
      message: string;
    }
  | { kind: "result"; status: string; error?: string };

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
  /** The region that started the run: a client, or the platform's scheduler. */
  caller: string;
  scheduled: boolean;
  startedAt: number;
  endedAt: number;
  args: Doc;
  presents?: TokenRef;
  steps: Step[];
  writes: Write[];
  schedules: string[];
  status: string | null;
  error?: string;
  tokens: TokenRef[];
}

export interface Recording {
  executions: Execution[];
}
