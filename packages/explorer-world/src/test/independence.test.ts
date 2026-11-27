/**
 * The engine, the layout, the scene and the UI know nothing of any one
 * project: no part, table, function, component, token or project of Convex
 * Auth or of the chat fixture is named in their code. Everything specific
 * comes from data under `projects/`, `fixtures/` and `presets/`.
 */
import { expect, test } from "vitest";
import { PROJECTS } from "../project.ts";

// The content of the vast sample of the looks gallery is hand-placed, like a
// project: it names the real files and functions on purpose.
const code = import.meta.glob<string>(
  [
    "../**/*.{ts,tsx}",
    "!../test/**",
    "!../**/*.test.ts",
    "!../looks/vast/world.ts",
    "!../looks/vast/motion.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** Words specific to a project: names of its parts and words of its presentation. */
function vocabulary(): Set<string> {
  const words = new Set<string>([
    "convex-auth",
    "Convex Auth",
    "refresh token",
    "access token",
    "chat",
  ]);
  for (const source of Object.values(PROJECTS)) {
    for (const p of source.structure.parts) {
      words.add(p.id);
      // Only distinctive names: generic words (users, list, send) are fair to use.
      if (/[A-Z_]/.test(p.name.slice(1)) && p.name.length >= 6)
        words.add(p.name);
    }
  }
  return words;
}

test("no module of the world names a part of a project", () => {
  const words = vocabulary();
  const hits: string[] = [];
  for (const [file, text] of Object.entries(code)) {
    const stripped = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const w of words) {
      const re = new RegExp(
        `(^|[^A-Za-z0-9_])${w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^A-Za-z0-9_])`,
      );
      if (re.test(stripped)) hits.push(`${file}: ${w}`);
    }
  }
  expect(Object.keys(code).length).toBeGreaterThan(20);
  expect(hits).toEqual([]);
});
