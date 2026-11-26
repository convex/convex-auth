/**
 * What failed to load or to draw, said on screen instead of showing nothing.
 * Nothing that loads over the network may blank the world: each thing that
 * can fail reports here, and the rest of the world carries on without it.
 */
import { create } from "zustand";
import { FONT, FONT_BOLD, FONT_MONO } from "./scene/fonts.ts";

interface Problems {
  list: string[];
  add: (text: string) => void;
}

export const useProblems = create<Problems>((set) => ({
  list: [],
  add: (text) =>
    set((s) => (s.list.includes(text) ? s : { list: [...s.list, text] })),
}));

export const reportProblem = (text: string) => useProblems.getState().add(text);

/** Frames the scene has drawn, for the watchdog and for scripted checks. */
export const frames = { count: 0 };

/** Requests the fonts of the 3D labels, as troika will, and says if one fails. */
export async function checkFonts(): Promise<void> {
  const failed: string[] = [];
  await Promise.all(
    [FONT, FONT_BOLD, FONT_MONO].map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) failed.push(`${url} (${res.status})`);
      } catch (e) {
        failed.push(`${url} (${e instanceof Error ? e.message : String(e)})`);
      }
    }),
  );
  if (failed.length)
    reportProblem(
      `The font of the 3D labels did not load: ${failed.join(", ")}. Names in the scene are hidden; the panels still show everything.`,
    );
}

/** Says so if the scene has drawn no frame after a while. */
export function watchFirstFrame(seconds = 30): void {
  setTimeout(() => {
    if (frames.count === 0)
      reportProblem(
        `The 3D scene has drawn no frame in ${seconds} s. Something it waits for may not have loaded; the panels still work.`,
      );
  }, seconds * 1000);
}
