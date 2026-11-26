/**
 * The generic layer on its own: the structure model of any Convex project,
 * from the directories of its apps. Components come from source when the
 * project or the package ships it, else from the types their parents see.
 *
 * @module
 */
import { dirname, join } from "node:path";
import type { StructureModel } from "../../model.ts";
import {
  componentSourceFiles,
  createProgram,
  isTypeScriptSource,
  listFiles,
  packageComponentSources,
} from "./program.ts";
import { ConvexProject, type ThirdParty } from "./project.ts";

export {
  ConvexProject,
  CONVEX_KINDS,
  type ThirdParty,
  type ProjectOptions,
} from "./project.ts";
export * from "./program.ts";

export type ConvexModelOptions = {
  /** The repository root: locations are relative to it, and type packages resolve from it. */
  root: string;
  /** The `convex/` directories of the apps. An app is named by the directory that holds it. */
  apps: string[];
  /** The third parties to name, if any. */
  thirdParties?: ThirdParty[];
  /** Also walk the app's frontend: the TypeScript files beside `convex/`, for client calls. */
  frontends?: boolean;
  /** The `types` packages the code needs, e.g. `["node", "vite/client"]` for a Vite frontend. */
  types?: string[];
};

export function buildConvexModel(options: ConvexModelOptions): StructureModel {
  const configs = options.apps.map((dir) => join(dir, "convex.config.ts"));
  const frontendFiles = (dir: string) =>
    listFiles(
      dirname(dir),
      (p) =>
        isTypeScriptSource(p) &&
        !p.startsWith(dir + "/") &&
        !/\.(test|config)\.tsx?$/.test(p) &&
        !/\.config\.ts$/.test(p),
    );
  const program = createProgram({
    root: options.root,
    types: options.types,
    files: [
      ...options.apps.flatMap((dir) =>
        listFiles(
          dir,
          (p) => isTypeScriptSource(p) && !/\.test\.tsx?$/.test(p),
        ),
      ),
      ...(options.frontends ? options.apps.flatMap(frontendFiles) : []),
      ...packageComponentSources(configs).flatMap(componentSourceFiles),
    ],
  });
  const project = new ConvexProject({
    root: options.root,
    program,
    components: [],
    apps: options.apps.map((dir) => ({
      name: dirname(dir).split("/").at(-1)!,
      dir,
    })),
    thirdParties: options.thirdParties ?? [],
  });
  project.walkFunctions();
  project.walkHttpRouters();
  if (options.frontends) {
    for (const app of project.apps) {
      for (const path of frontendFiles(app.dir)) {
        const file = program.getSourceFile(path);
        if (file !== undefined) {
          project.analyzer.walkModule(file, {
            from: app.id,
            owner: null,
            app: app.name,
            mode: "client",
          });
        }
      }
    }
  }
  project.scanPackageFetches();
  return project.model("convex");
}
