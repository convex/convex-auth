/**
 * Convex Auth: the structure map from `@convex-dev/explorer-structure`, two
 * recordings of the username-password example made with
 * `@convex-dev/explorer`, and how its parts look (`presentation.json`):
 *
 * - `page`: a browser driven through the `react-username-password` scenario
 *   (sign up, reload, a refresh the page schedules, sign out, a wrong
 *   password, sign in), with the page's calls, storage and tokens.
 * - `cli`: `npx convex run` calls: sign up, sign in, two refreshes, the reuse
 *   of a spent refresh token and the cleanup it schedules, a wrong password.
 */
import { structure } from "@convex-dev/explorer-structure";
import type { ProjectSource } from "../../src/project.ts";
import type { Presentation } from "../../src/presentation.ts";
import presentation from "./presentation.json";
import phrases from "./phrases.json";
import page from "./recording-page.ndjson?raw";
import cli from "./recording-cli.ndjson?raw";
import { insideOf } from "./inside.ts";
import { readStory } from "../../src/model/story.ts";

// The stories, one file each, in the order of their names.
const stories = Object.entries(
  import.meta.glob<unknown>("./stories/*.json", {
    eager: true,
    import: "default",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, json]) => readStory(json, name));

export const source: ProjectSource = {
  // The words of the play-by-play list: one phrase per step its code reports.
  presentation: { ...presentation, phrases } as Presentation,
  structure,
  timelines: { page, cli },
  inside: insideOf(structure),
  stories,
};
