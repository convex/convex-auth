/**
 * From what a recording of a Convex app holds to the parts of a structure
 * model. Runs on any runtime: it reads only the model.
 *
 * A recording names a function by the path of component instances from the
 * app (`""` for the app itself, `authPassword/rateLimiter`) and its
 * identifier (`auth:signUpWithUsernamePassword`); a step report names a call
 * target as one path (`authUsername/public/getUserIdByUsername`); a table
 * write names the component path and the table. The model's ids name
 * components by definition (`component:authPassword`) and instances from npm
 * by their path; the app's `mounts` dependencies carry the instance names
 * that connect the two.
 *
 * A run of an app function maps to the app's function part
 * (`fn:app:<app>:…`), not to the sign-in method's library definition; follow
 * its `definedBy` dependency to that.
 *
 * @module
 */
import type { PartBase } from "./model.ts";

/** The part of a model these functions need. */
type ModelLike = {
  parts: (PartBase & { kind: string })[];
  dependencies: { kind: string; from: string; to: string; via?: string[] }[];
};

export type Join = {
  /** The function part of a run, from its component path and identifier. */
  run(run: { componentPath: string | null; identifier: string }): string | null;
  /** The function part a step report's call target names, e.g. `authPassword/public/verifyPassword`. */
  callTarget(target: string): string | null;
  /** The table part of a document a recording shows, e.g. `{ component: "authPassword/rateLimiter", table: "rateLimits" }`. */
  table(write: { component: string | null; table: string }): string | null;
  /** The component part of a component path, e.g. `authPassword/rateLimiter`. */
  component(componentPath: string): string | null;
};

/** The join for the recordings of one app of the model, by its name (`react-username-password`). */
export function joinRecording(model: ModelLike, app: string): Join {
  const ids = new Set(model.parts.map((p) => p.id));
  const appId = `app:${app}`;
  if (!ids.has(appId)) {
    throw new Error(`The model has no app ${app}`);
  }
  const instances = new Map<string, string>();
  for (const d of model.dependencies) {
    if (d.kind === "mounts" && d.from === appId) {
      for (const instance of d.via ?? []) {
        instances.set(instance, d.to);
      }
    }
  }
  const keyOf = (id: string) => id.slice("component:".length);

  /** The id key of the component at a path of instance names. */
  const componentKey = (path: string): string | null => {
    const [first, ...rest] = path.split("/");
    const top = instances.get(first!);
    if (top === undefined) {
      return null;
    }
    let key = keyOf(top);
    for (const child of rest) {
      key = `${key}/${child}`;
      if (!ids.has(`component:${key}`)) {
        return null;
      }
    }
    return key;
  };

  const functionId = (componentPath: string, module: string, name: string) => {
    if (componentPath === "") {
      return `fn:app:${app}:${module}.${name}`;
    }
    const key = componentKey(componentPath);
    return key === null ? null : `fn:${key}:${module}.${name}`;
  };
  const existing = (id: string | null) =>
    id !== null && ids.has(id) ? id : null;

  return {
    run({ componentPath, identifier }) {
      const at = identifier.lastIndexOf(":");
      if (at === -1) {
        return null;
      }
      const module = identifier.slice(0, at).replace(/\.(js|ts)$/, "");
      return existing(
        functionId(componentPath ?? "", module, identifier.slice(at + 1)),
      );
    },
    callTarget(target) {
      const segments = target.split("/");
      const name = segments.at(-1)!;
      const matches = new Set<string>();
      // The component path and the module path both contain `/`: try every
      // split, and accept only a single match.
      for (let i = 0; i < segments.length - 1; i++) {
        const id = existing(
          functionId(
            segments.slice(0, i).join("/"),
            segments.slice(i, -1).join("/"),
            name,
          ),
        );
        if (id !== null) {
          matches.add(id);
        }
      }
      return matches.size === 1 ? [...matches][0]! : null;
    },
    table({ component, table }) {
      if (component === null || component === "") {
        return existing(`table:app:${app}.${table}`);
      }
      const key = componentKey(component);
      return key === null ? null : existing(`table:${key}.${table}`);
    },
    component(componentPath) {
      const key = componentKey(componentPath);
      return key === null ? null : existing(`component:${key}`);
    },
  };
}
