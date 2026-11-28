/** Hover state, outside React so hovering does not re-render the scene. */
export const hover = { label: "" };

/** The line each shape that can go away under the pointer set last. */
const hoverLines = new Map<string, string>();

/**
 * Sets the hover line on behalf of `from`, a shape that can go away while
 * the pointer is on it (no pointerout comes then), so that it can take its
 * line back with {@link hoverGone}.
 */
export function hoverFrom(from: string, label: string) {
  hover.label = label;
  hoverLines.set(from, label);
}

/** Clears the hover line if it is still the one `from` set. */
export function hoverGone(from: string) {
  const label = hoverLines.get(from);
  hoverLines.delete(from);
  if (label !== undefined && hover.label === label) hover.label = "";
}
