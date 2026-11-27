/**
 * Where the selection is on the window, each frame, for the card that
 * stands beside it (`ui/Card.tsx`): the card is HTML over the canvas, the
 * point is in the scene.
 */
import { useFrame } from "@react-three/fiber";
import { Vector3 } from "three";
import { currentState, usePlayback, world, type Selection } from "../store.ts";
import { anchorPosition, placementOf } from "./look.ts";

/** The selection's point on the window, in CSS pixels; `on` is false when it is behind the camera or off the window. */
export const cardAt = { x: 0, y: 0, on: false };

const v = new Vector3();

/** The point a selection stands at, at shown time `t`. */
export function selectionPoint(s: Selection, t: number, out: Vector3): boolean {
  switch (s.type) {
    case "part": {
      if (!placementOf(s.id)) return false;
      anchorPosition(s.id, out);
      return true;
    }
    case "row":
      anchorPosition(s.table, out);
      return true;
    case "cargo":
      anchorPosition(s.holder, out);
      return true;
    case "run": {
      const r = world.recording.runs.find((x) => x.id === s.id);
      if (!r) return false;
      anchorPosition(r.function, out);
      return true;
    }
    case "movement": {
      const m = world.timeline.movements.find((x) => x.id === s.id);
      if (!m) return false;
      const a = anchorPosition(m.from);
      const b = anchorPosition(m.to, out);
      const k = Math.min(
        1,
        Math.max(0, (t - m.start) / (m.end - m.start || 1)),
      );
      out.copy(a.lerp(b, k));
      return true;
    }
    case "op": {
      const o = world.timeline.ops.find((x) => x.id === s.id);
      if (!o?.points.length) return false;
      const at = [...o.points].reverse().find((p) => p.at <= t) ?? o.points[0];
      anchorPosition(at.anchor, out);
      return true;
    }
  }
}

export function CardAnchor() {
  useFrame(({ camera, size }) => {
    const s = usePlayback.getState().selected;
    if (!s || !selectionPoint(s, currentState().time, v)) {
      cardAt.on = false;
      return;
    }
    v.project(camera);
    cardAt.on = v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05;
    cardAt.x = ((v.x + 1) / 2) * size.width;
    cardAt.y = ((1 - v.y) / 2) * size.height;
  });
  return null;
}
