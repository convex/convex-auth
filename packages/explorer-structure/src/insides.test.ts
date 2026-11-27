import { describe, expect, test } from "vitest";
import { structure } from "./index.ts";

// The library's source, read only, to check the model against it.
const sources = import.meta.glob<string>(
  ["../../core/src/**/*.ts", "../../core/src/**/*.tsx"],
  { query: "?raw", import: "default", eager: true },
);
const source = (file: string): string => {
  const entry = Object.entries(sources).find(([path]) =>
    file.endsWith(path.replace(/^(\.\.\/)+/, "")),
  );
  if (entry === undefined) {
    throw new Error(`No source ${file}`);
  }
  return entry[1];
};

const moduleIds = structure.parts
  .filter((p) => p.kind === "module")
  .map((p) => p.id)
  .sort();

describe("the insides of the modules", () => {
  test("every module has one, and nothing else does", () => {
    expect(Object.keys(structure.modules ?? {}).sort()).toEqual(moduleIds);
    expect(moduleIds).toHaveLength(52);
  });

  test("a summary is copied from the source", () => {
    const normalize = (text: string) =>
      text
        .replace(
          /\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]+?))?\s*\}/g,
          (_, a, b) => b ?? a,
        )
        .replace(/^\s*\*/gm, " ")
        .replace(/\s+/g, " ");
    for (const [id, inside] of Object.entries(structure.modules!)) {
      const text = normalize(source(inside.file));
      for (const summary of [
        inside.summary,
        inside.description,
        ...inside.exports.map((e) =>
          e.from === undefined ? e.summary : undefined,
        ),
      ]) {
        if (summary !== undefined) {
          expect(text, id).toContain(summary);
        }
      }
    }
  });

  test("a module with no module doc comment has no summary", () => {
    const sessionManager = structure.modules!["module:browser/sessionManager"]!;
    expect(sessionManager.summary).toBeUndefined();
    expect(structure.modules!["module:browser/retry"]!.summary).toBe(
      "Retry policy for the client's auth calls (session refresh, OAuth code redemption).",
    );
  });

  test("each hook is the export of its module, by its part id", () => {
    const hooks = structure.parts.filter((p) => p.kind === "hook");
    expect(hooks).toHaveLength(32);
    for (const hook of hooks) {
      const exports = structure.modules![hook.parent!]!.exports.filter(
        (e) => e.part === hook.id,
      );
      expect(
        exports.map((e) => e.name),
        hook.id,
      ).toEqual([hook.name]);
    }
  });

  test("browser/sessionManager exports its API and keeps its state in AuthClient", () => {
    const inside = structure.modules!["module:browser/sessionManager"]!;
    expect(inside.exports.map((e) => `${e.kind} ${e.name}`)).toEqual([
      "interface SpaAuthApi",
      "interface SsrAuthApi",
      "type AuthClientConfig",
      "interface AuthState",
      "const INITIAL_AUTH_STATE",
      "class AuthClient",
    ]);
    expect(inside.state.map((s) => s.name)).toContain("#refreshToken");
    expect(inside.state.every((s) => s.class === "AuthClient")).toBe(true);
  });
});

describe("the step sites", () => {
  const calls = /\breport(?:Client)?Step\(/;

  test("each file's sites are exactly its calls of a reporter", () => {
    const files = new Set(structure.steps.map((s) => s.location.file));
    for (const [path, text] of Object.entries(sources)) {
      const lines = text
        .split("\n")
        .flatMap((line, i) =>
          calls.test(line) && !/^export function /.test(line.trim())
            ? [i + 1]
            : [],
        );
      const file = `packages/core/src/${path.split("/core/src/")[1]}`;
      if (/\.test\.tsx?$/.test(file)) {
        continue;
      }
      expect(
        structure.steps
          .filter((s) => s.location.file === file)
          .map((s) => s.location.line),
        file,
      ).toEqual(lines);
      if (lines.length > 0) {
        expect(files.has(file)).toBe(true);
      }
    }
  });

  test("browser/sessionManager has its 24 sites, all in AuthClient", () => {
    const sites = structure.steps.filter(
      (s) => s.part === "module:browser/sessionManager",
    );
    expect(sites).toHaveLength(24);
    expect(sites.every((s) => s.export === "AuthClient")).toBe(true);
    expect(
      sites
        .filter((s) => s.reportsAs === "module:browser/mutex")
        .map((s) => s.step),
    ).toEqual(["lock.request", "lock.acquired", "lock.released"]);
  });

  test("the sign-in steps report as the module that passes its id", () => {
    const call = structure.steps.find((s) => s.step === "signIn.call")!;
    expect(call.part).toBe("module:react/signInSteps");
    expect(call.reportsAs).toBeUndefined();
    expect(
      [...new Set(call.reportsAsPassedIn!.values.map((v) => v.part))].sort(),
    ).toEqual(["module:react/index", "module:ssr/nextjs/client"]);
  });

  test("the server sites sit in the core's setup", () => {
    const server = structure.steps.filter((s) => s.runsIn === "server");
    expect(server).toHaveLength(14);
    expect(structure.steps.filter((s) => s.runsIn === "browser")).toHaveLength(
      34,
    );
    expect(server.find((s) => s.step === "refresh.result")!.part).toBe(
      "methodFn:core.refreshSession",
    );
    expect(server.find((s) => s.step === "call")!.part).toBeNull();
  });

  test("no detail holds a value: keys are names", () => {
    for (const site of structure.steps) {
      for (const key of site.detailKeys) {
        expect(key).toMatch(/^[A-Za-z_$][\w$]*$/);
      }
    }
  });
});
