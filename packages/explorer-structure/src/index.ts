/**
 * The structure model of Convex Auth, as `structure.json` holds it, and the
 * types of structure models: the generic ones of any Convex project and the
 * ones Convex Auth adds.
 *
 * @module
 */
import model from "../structure.json" with { type: "json" };
import type { ConvexAuthStructure } from "./convex-auth/model.ts";

export type * from "./model.ts";
export type * from "./convex-auth/model.ts";

// JSON imports type their strings as `string`; the generator writes the model
// to this type.
export const structure = model as unknown as ConvexAuthStructure;

export { joinRecording, type Join } from "./join.ts";
export {
  stepOrigin,
  stepSites,
  type RecordedStep,
  type StepOrigin,
} from "./convex-auth/join.ts";
