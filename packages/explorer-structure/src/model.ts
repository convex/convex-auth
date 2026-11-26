/**
 * The types of `structure.json`: every part of Convex Auth and every
 * dependency between parts, as the generator in `generate/` reads them from
 * the source. See the README for the id scheme.
 *
 * @module
 */

/** A place in the repository: a path relative to its root, and a 1-based line. */
export type SourceLocation = {
  file: string;
  line: number;
};

/** Where a region runs. */
export type RegionKind =
  /** The browser: the React hooks and the browser modules. */
  | "browser"
  /** The server of a Next.js app (the SSR code of the core). */
  | "ssr"
  /** The app's own Convex backend: the app's functions and the sign-in methods. */
  | "app";

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

type PartBase = {
  /** Stable across runs: built from names, never from line numbers. */
  id: string;
  name: string;
  /** The id of the enclosing part, `null` for a top-level region. */
  parent: string | null;
  /** Where the part is defined. `null` only for a part with no source here. */
  source: SourceLocation | null;
};

export type Part =
  | (PartBase & { kind: "region"; region: RegionKind })
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
    })
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
    })
  | (PartBase & {
      kind: "exampleApp";
      /** The directory under `examples/`. */
      directory: string;
    });

export type PartKind = Part["kind"];

export type DependencyKind =
  /** A function calls a function through `ctx.runQuery` / `runMutation` / `runAction`. */
  | "calls"
  /** A component mounts a child component (`component.use`). */
  | "usesComponent"
  /** A function reads a table (`ctx.db.get` / `query`). */
  | "reads"
  /** A function writes a table (`ctx.db.insert` / `patch` / `replace` / `delete`). */
  | "writes"
  /** A function schedules a function (`ctx.scheduler.runAfter` / `runAt`). */
  | "schedules"
  /** Client code calls an app function (`useQuery`, `signInApi.mutation`, …). */
  | "clientCalls"
  /** An HTTP route is served by a handler. */
  | "routesTo"
  /** Code fetches a third-party host. */
  | "fetches"
  /** Browser code runs a WebAuthn ceremony against the passkey authenticator. */
  | "webauthn"
  /** A function calls a child component through its client library (`new RateLimiter(components.rateLimiter)`, `ping(ctx, components.batchWorker)`). */
  | "callsChildComponent"
  /** A function names another function without calling it (passes it on, makes a handle). */
  | "referencesFunction"
  /** A function reads an environment variable of its component or app. */
  | "readsEnv"
  /** An example app mounts a component (`app.use`). */
  | "mounts"
  /** An example app sets up a sign-in method. */
  | "usesMethod"
  /** An app function is the function that a sign-in method's `setup…` returns. */
  | "definedBy"
  /** A browser or SSR module imports another one. */
  | "imports";

export type Dependency = {
  kind: DependencyKind;
  from: string;
  to: string;
  /** Every place in the source that shows the dependency. */
  evidence: SourceLocation[];
  /** For `calls`: the `ctx` method. For `reads` / `writes`: the `ctx.db` methods. For `callsChildComponent`: the client function. */
  via?: string[];
  /**
   * The example app the dependency was resolved in, when it holds only there:
   * a reference the library receives as an argument, such as the function
   * reference of a hook, resolves only where an app passes one.
   */
  example?: string;
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

export type StructureModel = {
  /** Bumped on a breaking change to these types. */
  version: 1;
  parts: Part[];
  dependencies: Dependency[];
  unresolved: Unresolved[];
  counts: {
    parts: Partial<Record<PartKind, number>>;
    dependencies: Partial<Record<DependencyKind, number>>;
    unresolved: Partial<Record<UnresolvedKind, number>>;
  };
};
