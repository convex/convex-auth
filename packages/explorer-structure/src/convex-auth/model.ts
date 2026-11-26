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

export type ConvexAuthStructure = StructureModel<
  ConvexAuthPart,
  ConvexAuthDependencyKind
>;
