/**
 * The types of a structure model: every part of a Convex project and every
 * dependency between parts, as the generator reads them from the source.
 *
 * These are the generic types, for any Convex app or component. A project
 * adds its own parts and dependency kinds through the type parameters of
 * {@link StructureModel}; Convex Auth's are in `convex-auth/model.ts`. See the
 * README for the id scheme.
 *
 * @module
 */

/** A place in the repository: a path relative to its root, and a 1-based line. */
export type SourceLocation = {
  file: string;
  line: number;
};

export type FunctionType = "query" | "mutation" | "action" | "httpAction";

export type Visibility = "public" | "internal";

/** A field of a table, with its validator rendered as a TypeScript-like type. */
export type TableField = {
  name: string;
  type: string;
  optional: boolean;
};

export type TableIndex = {
  name: string;
  fields: string[];
};

/** What every part has. A project's own parts extend it. */
export type PartBase = {
  /** Stable across runs: built from names, never from line numbers. */
  id: string;
  name: string;
  /** The id of the enclosing part, `null` at the top. */
  parent: string | null;
  /** Where the part is defined. `null` only for a part with no source here. */
  source: SourceLocation | null;
};

/** The parts of any Convex project. */
export type ConvexPart =
  | (PartBase & {
      /**
       * Where code runs. The generic layer makes `region:app`, the Convex
       * backend of the apps; a project adds its own (a browser, an SSR server).
       */
      kind: "region";
      region: string;
    })
  | (PartBase & {
      /** A Convex app: a `convex/` directory with `defineApp`. */
      kind: "app";
      /** The directory of its `convex.config.ts`, from the repository root. */
      path: string;
    })
  | (PartBase & {
      kind: "component";
      /** The name its `defineComponent` gives it, e.g. `authPassword`. */
      componentName: string;
      /** The npm package of a component that lives outside this repository. */
      package: string | null;
    })
  | (PartBase & {
      kind: "thirdParty";
      /** The hosts the code is seen to reach, when it shows them. */
      hosts: string[];
    })
  | (PartBase & {
      kind: "table";
      fields: TableField[];
      indexes: TableIndex[];
    })
  | (PartBase & {
      kind: "function";
      /** The module path, as in `api.<module>.<name>`, with `/` between directories. */
      module: string;
      functionType: FunctionType;
      visibility: Visibility;
    })
  | (PartBase & {
      kind: "httpRoute";
      /** Relative to the `httpPrefix` the app mounts the component under. */
      path: string;
      method: string;
    })
  | (PartBase & {
      kind: "envVar";
      type: string;
      optional: boolean;
    });

/** The dependency kinds of any Convex project. */
export type ConvexDependencyKind =
  /** A function calls a function through `ctx.runQuery` / `runMutation` / `runAction`. */
  | "calls"
  /** A function schedules a function (`ctx.scheduler.runAfter` / `runAt`). */
  | "schedules"
  /** A function reads a table (`ctx.db.get` / `query`). */
  | "reads"
  /** A function writes a table (`ctx.db.insert` / `patch` / `replace` / `delete`). */
  | "writes"
  /** A component mounts a child component (`component.use`). */
  | "usesComponent"
  /** An app mounts a component (`app.use`). */
  | "mounts"
  /** A function calls a child component through its client library (`new RateLimiter(components.rateLimiter)`, `ping(ctx, components.batchWorker)`). */
  | "callsChildComponent"
  /** A function names another function without calling it (passes it on, makes a handle). */
  | "referencesFunction"
  /** A function reads an environment variable of its component or app. */
  | "readsEnv"
  /** An HTTP route is served by a handler. */
  | "routesTo"
  /** Code fetches a third-party host. */
  | "fetches"
  /** Code calls a library that talks to a third party (a WebAuthn ceremony, an SDK). */
  | "callsThirdParty"
  /** Client code calls an app function (`useQuery`, `client.mutation`, …). */
  | "clientCalls";

export type Dependency<Kind extends string = ConvexDependencyKind> = {
  kind: Kind;
  from: string;
  to: string;
  /** Every place in the source that shows the dependency. */
  evidence: SourceLocation[];
  /** For `calls`: the `ctx` method. For `reads` / `writes`: the `ctx.db` methods. For `callsChildComponent` and `callsThirdParty`: the library function. For `fetches`: the host. */
  via?: string[];
  /**
   * The app the dependency was resolved in, when it holds only there: a
   * reference that library code receives as an argument, such as the function
   * reference of a hook, resolves only where an app passes one.
   */
  app?: string;
};

export type UnresolvedKind =
  "call" | "functionReference" | "table" | "fetch" | "httpRoute" | "clientCall";

/** A dependency the generator found but could not resolve statically. */
export type Unresolved = {
  kind: UnresolvedKind;
  /**
   * The parts whose walks reached it. A site that any walk resolves, for
   * example in an app that passes the reference, is not listed.
   */
  from: string[];
  location: SourceLocation;
  /** The source text at the location, shortened. */
  code: string;
  reason: string;
};

/** What a module exports. `all` is an `export * from`, named `*`. */
export type ExportKind =
  | "function"
  | "class"
  | "const"
  | "let"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "default"
  | "all";

/** One export of a module, as its source declares it. */
export type ModuleExport = {
  name: string;
  /** What it is. A `const` whose value is a function is a `function`. */
  kind: ExportKind;
  /** The line of the export in the module's file. */
  line: number;
  /** The first sentence of its doc comment, copied from the source. Absent when it has none. */
  summary?: string;
  /**
   * For a re-export: where it comes from. The part id of a module the model
   * has, else the file's path from the repository root, else the import
   * specifier (an npm package).
   */
  from?: string;
  /** The part that this export is, when the model has one (a React hook). */
  part?: string;
  /** For a class this module declares: its public members, in the order of the source. */
  members?: {
    name: string;
    /** A field that holds a function is a `method`. */
    kind: "method" | "field" | "accessor";
    line: number;
    static?: boolean;
    summary?: string;
  }[];
};

/**
 * A place where a module keeps state: a `let` or `var` at its top level, a
 * `Map`, `Set`, `WeakMap`, or `WeakSet` that a top-level `const` holds, or a
 * field of one of its classes.
 */
export type ModuleState = {
  name: string;
  kind: "let" | "var" | "collection" | "field";
  line: number;
  /** For a field: its class. */
  class?: string;
  /** For a field: `readonly` (the binding, not what it holds). */
  readonly?: boolean;
  /** For a field: `#name` or `private`. */
  private?: boolean;
  static?: boolean;
  /** The first sentence of its doc comment, copied from the source. */
  summary?: string;
};

/**
 * The inside of a module, read from its source: what it says it is, what it
 * exports, and where it keeps state.
 */
export type ModuleInside = {
  /** The file, from the repository root. */
  file: string;
  /**
   * The first sentence of the file's module doc comment, copied from the
   * source. Absent when the file has none: never written by the generator.
   */
  summary?: string;
  /** The first paragraph of the module doc comment. */
  description?: string;
  /** In the order of the file. */
  exports: ModuleExport[];
  /** In the order of the file. */
  state: ModuleState[];
};

/**
 * What a reader needs to draw a kind it does not know: the layer that defines
 * it (`convex` for the generic layer, else the project layer's name), a label,
 * and a sentence.
 */
export type KindInfo = {
  layer: string;
  label: string;
  description: string;
};

/**
 * A structure model. `ExtraPart` and `ExtraDependencyKind` are the parts and
 * the dependency kinds a project's own layer adds to the generic ones.
 */
export type StructureModel<
  ExtraPart extends PartBase & { kind: string } = never,
  ExtraDependencyKind extends string = never,
> = {
  /** Bumped on a breaking change to these types. */
  version: 3;
  /** The project layer that produced the model, e.g. `convex-auth`, or `convex` for the generic layer alone. */
  project: string;
  /** Every part and dependency kind the model uses, with its layer and label. */
  kinds: {
    parts: Record<(ConvexPart | ExtraPart)["kind"], KindInfo>;
    dependencies: Record<ConvexDependencyKind | ExtraDependencyKind, KindInfo>;
  };
  parts: (ConvexPart | ExtraPart)[];
  dependencies: Dependency<ConvexDependencyKind | ExtraDependencyKind>[];
  unresolved: Unresolved[];
  /**
   * The insides of the modules a project layer reads, by part id. Kept apart
   * from `parts` so that the parts, and the layout that follows them, do not
   * change when the inside of a module does.
   */
  modules?: Record<string, ModuleInside>;
  counts: {
    parts: Partial<Record<(ConvexPart | ExtraPart)["kind"], number>>;
    dependencies: Partial<
      Record<ConvexDependencyKind | ExtraDependencyKind, number>
    >;
    unresolved: Partial<Record<UnresolvedKind, number>>;
  };
};
