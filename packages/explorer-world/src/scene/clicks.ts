/**
 * A click is a press and release in place. R3F fires `onClick` whenever both
 * hit the same object, however far the pointer moved between them, and a
 * drag that pans the map keeps the object under the pointer: so every click
 * handler of the scene, and `onPointerMissed`, asks `isDrag` first.
 */

/** How far the pointer may move between press and release, in CSS pixels. */
export const CLICK_SLOP = 5;

const down = { x: 0, y: 0 };
window.addEventListener(
  "pointerdown",
  (e) => {
    down.x = e.clientX;
    down.y = e.clientY;
  },
  { capture: true },
);

/** Whether this click ended a drag: the pointer moved since its press. */
export function isDrag(e: MouseEvent | { nativeEvent: MouseEvent }): boolean {
  const n = "nativeEvent" in e ? e.nativeEvent : e;
  return Math.hypot(n.clientX - down.x, n.clientY - down.y) > CLICK_SLOP;
}
