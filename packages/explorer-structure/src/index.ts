/**
 * The structure model of Convex Auth, as `structure.json` holds it.
 *
 * @module
 */
import model from "../structure.json" with { type: "json" };
import type { StructureModel } from "./model.ts";

export type * from "./model.ts";

export const structure = model as StructureModel;
