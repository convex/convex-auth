/**
 * The one module that knows the data formats of this project. It reads the
 * structure of the slice and the recorded run, and returns them in the model
 * of `src/model/types.ts`, which knows no codebase.
 *
 * Both formats are provisional: `packages/explorer-structure` will generate the
 * structure and `packages/explorer` will record the run. When their formats
 * land, rewrite this module; nothing else reads the files.
 */
import type {
  Doc,
  Execution,
  FunctionDef,
  Place,
  Recording,
  Region,
  Step,
  Structure,
  TableDef,
  TokenKind,
  TokenRef,
  Tone,
  Write,
} from "../../src/model/types.ts";
import rawRun from "./run.provisional.json";
import rawStructure from "./structure.provisional.json";

/** The table that stores refresh tokens, by hash. */
const REFRESH_TOKENS = "auth:refreshTokens";
const ENTRY = "platform:gate";
const ISSUER = "platform:signer";
const SCHEDULER = "platform:scheduler";

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
  method?: string;
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
  presents?: { kind: string; label: string; row?: string };
  steps: RawStep[];
  writes: { table: string; op: string; id: string; label?: string; doc: Doc }[];
  schedules?: { function: string }[];
  returned: {
    status?: string;
    userError?: string;
    tokens?: { kind: string; label: string; row?: string }[];
  } | null;
}

function tokenRef(raw: {
  kind: string;
  label: string;
  row?: string;
}): TokenRef {
  return {
    kind: raw.kind,
    label: raw.label,
    ...(raw.row ? { table: REFRESH_TOKENS, row: raw.row } : {}),
  };
}

function statusTone(status: string | undefined): Tone {
  if (status === "error") return "error";
  if (status === "noSession") return "warn";
  return "normal";
}

function valueTone(value: string | undefined): Tone {
  if (/INVALID|error/i.test(value ?? "")) return "error";
  if (/no session/i.test(value ?? "")) return "warn";
  return "normal";
}

function step(raw: RawStep, ex: RawExecution): Step {
  switch (raw.step) {
    case "method.start":
      return {
        kind: "start",
        label:
          raw.method === "usernamePassword"
            ? "username + password method"
            : raw.method,
      };
    case "call":
      return { kind: "call", target: raw.target! };
    case "return":
      return {
        kind: "return",
        target: raw.target!,
        value: raw.value,
        tone: valueTone(raw.value),
      };
    case "session.issued": {
      const access = ex.returned?.tokens?.find((t) => t.kind === "access");
      return {
        kind: "issue",
        place: ISSUER,
        text: "session issued — the platform signs an access token",
        token: access ? tokenRef(access) : undefined,
      };
    }
    case "log":
      return {
        kind: "log",
        level: (raw.level ?? "info") as "info" | "warn" | "error",
        region: raw.region ?? "app",
        message: raw.message ?? "",
      };
    case "method.result":
    case "refresh.result":
      return {
        kind: "result",
        status: raw.status ?? "",
        error: raw.userError,
        tone: statusTone(raw.status),
      };
    default:
      throw new Error(`Unknown step "${raw.step}"`);
  }
}

function execution(raw: RawExecution): Execution {
  const status = raw.returned?.status ?? null;
  const presents = raw.presents ? tokenRef(raw.presents) : undefined;
  return {
    id: raw.id,
    title: raw.title,
    function: raw.function,
    caller: raw.scheduled ? SCHEDULER : raw.caller,
    scheduled: raw.scheduled ?? false,
    entry: raw.scheduled ? undefined : ENTRY,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    args: raw.args,
    presents,
    steps: raw.steps.map((s) => step(s, raw)),
    writes: raw.writes.map((w): Write => ({
      table: w.table,
      op: w.op as Write["op"],
      row: w.id,
      label: w.label,
      doc: w.doc,
    })),
    schedules: (raw.schedules ?? []).map((s) => s.function),
    status,
    error: raw.returned?.userError,
    tone: statusTone(status ?? undefined),
    tokens: (raw.returned?.tokens ?? []).map(tokenRef),
    // A revoked session: the caller's refresh token is worthless now.
    drops: status === "noSession" && presents ? [presents] : [],
  };
}

const KINDS: Record<string, Region["kind"]> = {
  client: "client",
  platform: "platform",
  app: "service",
  component: "service",
};

export function loadStructure(): Structure {
  const regions = rawStructure.regions.map((r): Region => ({
    id: r.id,
    kind: KINDS[r.kind],
    tag: r.kind,
    label: r.label,
    parent: r.parent,
    package: r.package,
    summary: r.summary,
  }));
  return {
    regions,
    places: rawStructure.places as Place[],
    functions: rawStructure.functions.map((f): FunctionDef => {
      const region = regions.find((r) => r.id === f.region);
      const short = f.name.replace(/^public\./, "").replace(/^auth:/, "");
      return {
        id: f.id,
        region: f.region,
        name: f.name,
        short,
        // A component function reads as `component.function`.
        label:
          region?.tag === "component"
            ? `${region.label}.${f.name.replace(/^public\./, "")}`
            : f.name,
        type: f.type as FunctionDef["type"],
        visibility: f.visibility,
        scheduled: "scheduled" in f && f.scheduled === true,
        summary: f.summary,
      };
    }),
    tables: rawStructure.tables as TableDef[],
    tokens: rawStructure.tokens as TokenKind[],
  };
}

export function loadRecording(): Recording {
  return {
    executions: (rawRun.executions as unknown as RawExecution[]).map(execution),
  };
}
