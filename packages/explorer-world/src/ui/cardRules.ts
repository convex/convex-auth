/**
 * The rules of the card (`Card.tsx`) that do not need the scene: which way
 * to the thing it offers, where it stands on the window, and how a line
 * from the source reads on it.
 */

/**
 * What the card offers to get to a part: "open" to fly close where its
 * inside opens, "go" to fly to it, or nothing when the camera is already
 * framing it open. An open part the camera is not at still gets its way
 * there.
 */
export function wayThere(
  part: string,
  opens: boolean,
  framed: string | null,
): "open" | "go" | null {
  if (opens) return framed === part ? null : "open";
  return "go";
}

/** The window, the card's size and the point it is about, in CSS pixels. */
export interface CardFit {
  W: number;
  H: number;
  w: number;
  h: number;
  /** The point on the window, or `null` when it is off it. */
  at: { x: number; y: number } | null;
  /** The part is open and framed: the card stands at the side. */
  aside: boolean;
  /**
   * Where the window is free on the left (px): right of a column standing
   * there. A card standing by its part keeps right of it; a docked card
   * keeps the corner (the column moves under it).
   */
  left?: number;
  /** Where a docked card stands from the top (px): under a story's caption. */
  top?: number;
}

/** Room kept clear above the point: the part's name and where its arcs leave. */
const ABOVE = 70;
/** Gap to the side of the point. */
const SIDE = 56;
/** Room at the bottom for the controls. */
const BOTTOM = 96;

/**
 * Where the card stands: beside and below the point, so that the part, its
 * name above it and the arcs that rise from it stay in view; else beside
 * and above, clear of the name; to the right first. Off the window, or
 * while the part is open and framed, at the top left.
 */
export function placeCard({
  W,
  H,
  w,
  h,
  at,
  aside,
  left: free = 12,
  top = 16,
}: CardFit): {
  x: number;
  y: number;
} {
  if (aside || !at) return { x: 16, y: top };
  const fits = (x: number, y: number) =>
    x >= free && x + w <= W - 12 && y >= 12 && y + h <= H - BOTTOM;
  const right = at.x + SIDE;
  const left = at.x - SIDE - w;
  const below = at.y + 24;
  const above = at.y - ABOVE - h;
  for (const [x, y] of [
    [right, below],
    [left, below],
    [right, above],
    [left, above],
  ] as const)
    if (fits(x, y)) return { x, y };
  return {
    x: Math.min(Math.max(free, right), W - w - 12),
    y: Math.min(Math.max(12, below), H - h - BOTTOM),
  };
}

/**
 * A line from the source as the card shows it: a sentence that ends in a
 * colon introduces a list the card does not show, so the colon goes.
 */
export const cardLine = (text: string) => text.replace(/\s*:\s*$/, "");
