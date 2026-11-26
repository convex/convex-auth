/**
 * The one module that knows the data formats. It reads the structure of the
 * slice and the recorded run, and returns them in the model of `types.ts`.
 *
 * Both formats are provisional: `packages/explorer-structure` will generate the
 * structure and `packages/explorer` will record the run. When their formats
 * land, rewrite this module; nothing else reads the files.
 */
import rawRun from "../../data/run.provisional.json";
import rawStructure from "../../data/structure.provisional.json";
import type {
  Doc,
  Execution,
  FunctionDef,
  Recording,
  Region,
  Step,
  Structure,
  TableDef,
  TokenRef,
  Write,
} from "./types.ts";

interface RawStep {
  step: string;
  target?: string;
  value?: string;
  session?: string;
  level?: string;
  region?: string;
  message?: string;
  status?: string;
  userError?: string;
}

interface RawExecution {
  id: string;
  title: string;
  function: string;
  caller: string;
  scheduled?: boolean;
  startedAt: number;
  endedAt: number;
  args: Doc;
  presents?: TokenRef;
  steps: RawStep[];
  writes: { table: string; op: string; id: string; label?: string; doc: Doc }[];
  schedules?: { function: string }[];
  returned: {
    status?: string;
    userError?: string;
    tokens?: { kind: string; label: string; row?: string }[];
  } | null;
}

function step(raw: RawStep): Step {
  switch (raw.step) {
    case "method.start":
      return { kind: "start" };
    case "call":
      return { kind: "call", target: raw.target! };
    case "return":
      return { kind: "return", target: raw.target!, value: raw.value };
    case "session.issued":
      return { kind: "sessionIssued", session: raw.session };
    case "log":
      return {
        kind: "log",
        level: (raw.level ?? "info") as "info" | "warn" | "error",
        region: raw.region ?? "app",
        message: raw.message ?? "",
      };
    case "method.result":
    case "refresh.result":
      return { kind: "result", status: raw.status ?? "", error: raw.userError };
    default:
      throw new Error(`Unknown step "${raw.step}"`);
  }
}

function execution(raw: RawExecution): Execution {
  return {
    id: raw.id,
    title: raw.title,
    function: raw.function,
    caller: raw.caller,
    scheduled: raw.scheduled ?? false,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    args: raw.args,
    presents: raw.presents,
    steps: raw.steps.map(step),
    writes: raw.writes.map((w): Write => ({
      table: w.table,
      op: w.op as Write["op"],
      row: w.id,
      label: w.label,
      doc: w.doc,
    })),
    schedules: (raw.schedules ?? []).map((s) => s.function),
    status: raw.returned?.status ?? null,
    error: raw.returned?.userError,
    tokens: (raw.returned?.tokens ?? []).map((t) => ({
      kind: t.kind as TokenRef["kind"],
      label: t.label,
      row: t.row,
    })),
  };
}

export function loadStructure(): Structure {
  return {
    regions: rawStructure.regions as Region[],
    functions: rawStructure.functions.map((f): FunctionDef => ({
      id: f.id,
      region: f.region,
      name: f.name,
      type: f.type as FunctionDef["type"],
      visibility: f.visibility as FunctionDef["visibility"],
      scheduled: "scheduled" in f && f.scheduled === true,
      summary: f.summary,
    })),
    tables: rawStructure.tables as TableDef[],
  };
}

export function loadRecording(): Recording {
  return {
    executions: (rawRun.executions as unknown as RawExecution[]).map(execution),
  };
}
