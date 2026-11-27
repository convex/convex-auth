/**
 * The parts and dependency kinds that only Convex Auth has: its sign-in
 * methods, its React hooks, and its browser and SSR modules. They extend the
 * generic model of `../model.ts`.
 *
 * @module
 */
import type {
  FunctionType,
  PartBase,
  SourceLocation,
  StructureModel,
  Visibility,
} from "../model.ts";

export type ConvexAuthPart =
  | (PartBase & {
      kind: "method";
      /** The directory under `methods/`, e.g. `username-password`. */
      directory: string;
      /** The package entry point of its server code, if it has one. */
      entryPoint: string | null;
    })
  | (PartBase & {
      /** A `setup…` function: the app calls it to get its auth functions. */
      kind: "setupFunction";
    })
  | (PartBase & {
      /** An app function that a `setup…` function returns. */
      kind: "methodFunction";
      functionType: FunctionType;
      visibility: Visibility;
    })
  | (PartBase & { kind: "hook"; runsIn: "browser" | "ssr" })
  | (PartBase & {
      /** A module of the browser or SSR code of the core or of a method. */
      kind: "module";
      /** The path under `packages/core/src`. */
      module: string;
      runsIn: "browser" | "ssr";
    });

export type ConvexAuthDependencyKind =
  /** An app sets up a sign-in method (or the core) by calling its `setup…`. */
  | "usesMethod"
  /** An app function is the function that a sign-in method's `setup…` returns. */
  | "definedBy"
  /** A browser or SSR module imports another one. */
  | "imports";

/**
 * A place in the source that reports a step (see `packages/core/src/browser/steps.ts`
 * and `packages/core/src/lib/steps.ts`), with what the source says of it.
 */
export type StepSite = {
  /** The step's name, as the report carries it in `step`. */
  step: string;
  /** `browser` for `reportClientStep`, `server` for `reportStep`. */
  runsIn: "browser" | "server";
  location: SourceLocation;
  /**
   * The part whose code holds the call: the module of a client file; on the
   * server, the method function or the setup function it is inside. `null`
   * where no part holds it (`lib/steps.ts`).
   */
  part: string | null;
  /**
   * The top-level export of the file that holds the call, or `null` when the
   * call is in code the file does not export.
   */
  export: string | null;
  /** For a call in code the file does not export: the file's exports that reach that code. */
  reachedFrom?: string[];
  /** The named functions around the call, outermost first, e.g. `["AuthClient", "#refreshHoldingLock"]`. */
  within: string[];
  /**
   * The part the report names in `part`, when the call spells it out (as a
   * literal or a constant). A server report names none: it belongs to the run
   * of the function that wrote it.
   */
  reportsAs?: string;
  /**
   * When the part is passed in rather than spelled out: the parameter, and
   * every value the callers pass, with where. A caller that passes a value
   * the source does not spell out adds `null`.
   */
  reportsAsPassedIn?: {
    parameter: string;
    values: { part: string | null; location: SourceLocation }[];
  };
  /** The names of the detail's keys (never a value), in the order of the source. */
  detailKeys: string[];
  /**
   * The code of the spreads in the detail whose keys the types do not tell,
   * e.g. `outcomeOf(result)`: the report may hold more keys than `detailKeys`.
   */
  detailOpen?: string[];
};

/** A use of a stored key: a key of a `NamespacedStorage` or a `SignInStorage` (`browser/storage.ts`). */
export type StorageKeyUse = {
  /** The logical key, before the storage adds its namespace or a sign-in's id. */
  key: string;
  /** The view it goes through: `NamespacedStorage` suffixes the namespace, `SignInStorage` prefixes the sign-in's id. */
  store: "NamespacedStorage" | "SignInStorage";
  /** `get`, `set`, `remove`, or `key` (the stored key is computed, e.g. for a lock or a storage event). */
  ops: ("get" | "set" | "remove" | "key")[];
  evidence: SourceLocation[];
};

/** A lock a module takes with `runWithMutex` (`browser/mutex.ts`). */
export type LockUse = {
  /** The lock's name: a stored key of a `NamespacedStorage`, by its logical key. `null` when the source does not tell. */
  storageKey: string | null;
  code: string;
  location: SourceLocation;
};

/** What a client module holds, where the source says it plainly. */
export type ModuleHolds = {
  storage: StorageKeyUse[];
  /** Calls whose key the source does not spell out. */
  unresolvedStorage: { code: string; location: SourceLocation }[];
  locks: LockUse[];
};

export type ConvexAuthStructure = StructureModel<
  ConvexAuthPart,
  ConvexAuthDependencyKind
> & {
  /** Every call that reports a step, in the order of file and line. */
  steps: StepSite[];
  /** What the client modules hold, by part id; only modules that hold something. */
  holds: Record<string, ModuleHolds>;
};
