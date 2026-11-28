/**
 * The boxes the declutter pass (`Labels.tsx`) keeps apart on screen, in
 * pixels: [left, top, right, bottom].
 */
export type Box = [number, number, number, number];

/** The clear space kept between any two names shown (px). */
export const GAP = 6;

/**
 * The width of a name for each pixel of its font size, before its text is
 * laid out. The bold font runs to about 0.64 per character ("anonymous"),
 * the regular one a little less.
 */
export const CHAR_EM = 0.64;

/**
 * The box of a name centred at (`cx`, `cy`), `px` pixels high per line,
 * `em` font sizes wide (its laid-out width over its font size), grown by
 * half of `GAP` on each side so two boxes that do not overlap leave `GAP`
 * between their names.
 */
export function nameBox(
  cx: number,
  cy: number,
  px: number,
  em: number,
  lines: number,
): Box {
  const w = (em * px) / 2 + GAP / 2;
  return [
    cx - w,
    cy - px * 0.6 - GAP / 2,
    cx + w,
    cy + px * (0.6 + (lines - 1) * 0.6) + GAP / 2,
  ];
}

/** Whether `box` overlaps any of `shown`. */
export function overlapsAny(box: Box, shown: Box[]): boolean {
  return shown.some(
    (r) => box[0] < r[2] && box[2] > r[0] && box[1] < r[3] && box[3] > r[1],
  );
}
