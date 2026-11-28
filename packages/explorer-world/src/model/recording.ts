/**
 * What happened: the function runs of a recording, in neutral terms. An
 * adapter builds it from a recorder's timeline and resolves every name to a
 * part of the graph. Anything the data does not say outright but the adapter
 * works out carries a `Derivation` that says how.
 */

import type { Report } from "./inside.ts";

export type Doc = Record<string, unknown>;

export type Tone = "normal" | "warn" | "error";

/** How a fact the recording does not state was worked out. */
export interface Derivation {
  /** The name of the rule, e.g. `write-by-commit-time`. */
  rule: string;
  /** One sentence for the inspector. */
  note: string;
}

export type Step =
  | {
      kind: "call";
      /** The part called. */
      target: string;
      /** The kind of call, as the report says (query, mutation, …). */
      callKind?: string;
    }
  | { kind: "return"; target: string; tone: Tone }
  | {
      /** A step report the world has no picture for: shown as it is. */
      kind: "note";
      name: string;
      text: string;
      tone: Tone;
      detail: Doc;
    }
  | {
      kind: "log";
      level: string;
      /** The part that logged it. */
      part: string;
      message: string;
      tone: Tone;
    };

export interface Write {
  /** The table part. */
  table: string;
  row: string;
  op: "insert" | "update" | "delete";
  /** The document after the write; empty for a delete. */
  doc: Doc;
  /** The fields that changed, for an update. */
  changed: string[];
  /** When the write committed, in ms. */
  time: number;
  /** Set when the recording does not say which run wrote it. */
  derived?: Derivation;
}

/** A row a request or a response carries, such as a token it stores. */
export interface Cargo {
  table: string;
  row: string;
  label: string;
  /** The label of the secret in the recording (`s3`), when the recording shows it. */
  secret?: string;
  /** What it is, without its label (`access token`), from the presentation. */
  noun?: string;
  /** Set when the recording does not show the value travel. */
  derived?: Derivation;
}

/**
 * One thing a request or a response carried, as the recording shows it: a
 * token the recorder replaced by its label (`{"$secret":"s5"}`), or a field
 * it redacted (`"password":"[redacted]"`). Never a value.
 */
export type Load =
  | {
      kind: "secret";
      /** The recorder's label (`s5`). */
      secret: string;
      /** Its type as the recorder saw it (`jwt`, `opaque`). */
      type: string;
      /** The field it was in. */
      field: string;
      /** The row it is, when the recording links it to one. */
      cargo?: Cargo;
    }
  | { kind: "redacted"; field: string };

/** The sign-in state of a page, as its client library reports it. */
export type PageState =
  "loading" | "signedOut" | "signingIn" | "signedIn" | "error";

/**
 * Something a client page did outside a function run: an input, a
 * navigation, a change to its storage, a step of the scenario that drove it,
 * a call the recording could not link to one run.
 */
export interface PageItem {
  time: number;
  kind: string;
  /** The page part. */
  part: string;
  text: string;
  tone: Tone;
  /** What the page starts or stops holding (a token it stores or removes). */
  hold?: { op: "gain" | "drop"; cargo: Cargo; where: string };
  /** Where it stands in its page's own order of events, when recorded. */
  order?: { page: string; seq: number };
  /** For an unlinked call: the runs it may be, one of which it is. */
  candidates?: string[];
  /** For an unlinked call: the kind of function it called (`query`). */
  callType?: string;
  /** The parts it lights while it plays: the module that reported a step, the key it named. */
  lights?: string[];
  /** For a step the client library reported: its name. */
  step?: string;
  /** For a step: the report as running code wrote it, to find the place in the source that wrote it. */
  report?: Report;
  /** The sign-in state the page is in after it. */
  state?: { holder: string; state: PageState };
  /**
   * For a step: the operation of the client it belongs to, as the client
   * reported it, made unique by page and document load; its kind; and the
   * operation that started it, when the client knows.
   */
  op?: string;
  opKind?: string;
  /** For a step that names a function (`signIn.call`): its name, `module:export`. */
  fn?: string;
  /**
   * For a step that reported an error: the error's code, when the client
   * gave one from its fixed list (`INVALID_CREDENTIALS`); never message text.
   */
  code?: string;
  /** For a page event: the document finished loading (the recorded `load`). */
  loaded?: true;
  /** For a step of the scenario (a pressed control): whether it starts or ends. */
  scenario?: "start" | "end";
  /** For the start of a step of the scenario: its name, as the scenario gives it. */
  pressed?: string;
  /** For an input: what the person did, and to which element (by its name, never a value). */
  input?: { action: string; what: string };
  parentOp?: string;
}

export interface Run {
  id: string;
  /** The function part that ran. */
  function: string;
  /** The place the run came from: a caller such as an HTTP client or the scheduler. */
  caller: string;
  /** The way out of the caller's region the request left by (a page's WebSocket), when recorded. */
  via?: string;
  /** The part of the caller that sent it (a module of the page's client library), if known. */
  sender?: { part: string; derived: Derivation };
  /** Real start and end, in ms. */
  startedAt: number;
  endedAt: number;
  /**
   * When the page that called it sent the request and got the response, by
   * the page's clock (ms), when recorded: the times the page's own steps are
   * ordered against.
   */
  sentAt?: number;
  answeredAt?: number;
  /** Where the request stands in its page's order of events, when recorded. */
  order?: { page: string; seq: number };
  /** The kind of function, as the recording says. */
  type: string;
  ok: boolean;
  error: string | null;
  /** A one-word outcome, from the run or its last step report. */
  status: string;
  tone: Tone;
  steps: Step[];
  writes: Write[];
  /** The run that scheduled this one, if any. */
  scheduledBy?: { run: string; derived?: Derivation };
  /** Rows the request carries in, and the response carries out. */
  carriesIn: Cargo[];
  carriesOut: Cargo[];
  /** Everything the request and the response carried, as the recording shows it. */
  loadIn?: Load[];
  loadOut?: Load[];
  /** What a page did before the run (only the first run has these) and after it. */
  before: PageItem[];
  after: PageItem[];
  /** The step of the scenario the run happened in, if a scenario drove the page. */
  section?: string;
  /** The facts of the run as recorded, for the inspector. */
  facts: [name: string, value: string][];
}

/** Something in the recording the world has no place for. */
export interface Unplaced {
  what: string;
  reason: string;
}

export interface Recording {
  /** Its name among the project's recordings. */
  name?: string;
  /** When the recording started, in ms. */
  startedAt: number;
  /**
   * The app the recording ran in: the one its `recording` event names, else
   * the presentation's `focus`, else the app its runs name most.
   */
  app?: string;
  runs: Run[];
  /**
   * What the page did while no run had happened yet (a page that loads
   * signed out calls nothing): played on its own, before the runs. With a
   * run, it is that run's `before`.
   */
  early?: PageItem[];
  /** Rows that existed when the recording started. */
  snapshot: Write[];
  unplaced: Unplaced[];
  /** How many events of each kind the recording had, and how many were played. */
  events: Record<string, { seen: number; played: number }>;
}
