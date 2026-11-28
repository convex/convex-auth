/**
 * Where the play-by-play list comes to rest. The open section's heading
 * stays at the top while its lines scroll under it, so a line can rest half
 * hidden behind it. The list rests only at a stop: a scroll that puts a
 * heading at the top, or a line of the open section just under its heading.
 * The browser's scroll snapping cannot say that: its padding is one length
 * for every line, and it lets a scroll by script rest between stops.
 *
 * @module
 */

/** A heading or line, in the list's content, from the top of its first. */
export type Stop = {
  top: number;
  bottom: number;
  /** The height of the heading stuck above it when it rests at the top. */
  under: number;
};

/** The scroll at which a heading or line rests at the top. */
export const stopOf = (s: Stop) => s.top - s.under;

/**
 * The scroll the list rests at: the stop nearest `current` that keeps `lit`,
 * the line being played, whole between the heading and the bottom edge.
 * With no stop that does (`lit` taller than the list), the one that shows
 * its top.
 */
export function restingTop(
  current: number,
  height: number,
  max: number,
  stops: readonly Stop[],
  lit?: Stop,
): number {
  const at = [
    ...new Set(stops.map(stopOf).filter((s) => s >= 0 && s <= max + 0.5)),
  ];
  if (!at.includes(0)) at.push(0);
  const lo = lit ? lit.bottom - height : -Infinity;
  const hi = lit ? stopOf(lit) : Infinity;
  const nearest = (from: number[]) =>
    from.reduce((a, b) =>
      Math.abs(b - current) < Math.abs(a - current) ? b : a,
    );
  const fit = at.filter((s) => s >= lo - 0.5 && s <= hi + 0.5);
  if (fit.length > 0) return nearest(fit);
  const above = at.filter((s) => s <= hi + 0.5);
  return above.length > 0 ? Math.max(...above) : nearest(at);
}

/**
 * The space after the last line that makes the end of the list a stop: the
 * list scrolled to its end then starts with a whole line too.
 */
export function endSpace(
  content: number,
  height: number,
  stops: readonly Stop[],
): number {
  const natural = content - height;
  if (natural <= 0) return 0;
  const after = stops.map(stopOf).filter((s) => s >= natural - 0.5);
  return after.length > 0 ? Math.max(0, Math.min(...after) - natural) : 0;
}

/** The stops of the list `box`, read from the page. */
function stopsOf(box: HTMLElement): { stops: Stop[]; lit?: Stop } {
  const origin =
    box.getBoundingClientRect().top + box.clientTop - box.scrollTop;
  const open = box.querySelector<HTMLElement>(".section.expanded > .heading");
  const under = open?.offsetHeight ?? 0;
  const stops: Stop[] = [];
  let lit: Stop | undefined;
  for (const section of box.querySelectorAll<HTMLElement>(".section")) {
    // The section's own box: a stuck heading's box is where it is stuck.
    const r = section.getBoundingClientRect();
    const heading = section.querySelector<HTMLElement>(".heading");
    stops.push({
      top: r.top - origin,
      bottom: r.top - origin + (heading?.offsetHeight ?? 0),
      under: 0,
    });
    for (const line of section.querySelectorAll<HTMLElement>(".line")) {
      const l = line.getBoundingClientRect();
      const stop = { top: l.top - origin, bottom: l.bottom - origin, under };
      stops.push(stop);
      if (line.classList.contains("now")) lit = stop;
    }
  }
  return { stops, lit };
}

/**
 * Brings the list to rest; with `keepLit`, with the line being played whole.
 * `spacer` is the last element of the list, which holds {@link endSpace}.
 */
export function settle(
  box: HTMLElement,
  spacer: HTMLElement | null,
  keepLit: boolean,
): void {
  const { stops, lit } = stopsOf(box);
  if (spacer) {
    const space = spacer.offsetHeight;
    const want = endSpace(box.scrollHeight - space, box.clientHeight, stops);
    if (Math.abs(want - space) > 0.5) spacer.style.height = `${want}px`;
  }
  const max = box.scrollHeight - box.clientHeight;
  const top = restingTop(
    box.scrollTop,
    box.clientHeight,
    max,
    stops,
    keepLit ? lit : undefined,
  );
  if (Math.abs(top - box.scrollTop) > 0.5) box.scrollTop = top;
}
