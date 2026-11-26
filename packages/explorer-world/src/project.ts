/**
 * The one module that names the project the world shows. Another codebase
 * gets a world by adding a directory under `projects/` (its data, an adapter
 * for its formats, and a `ProjectConfig`) and pointing this import at it.
 */
export { project } from "../projects/convex-auth/index.ts";
