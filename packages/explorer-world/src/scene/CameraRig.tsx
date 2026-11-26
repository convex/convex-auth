import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Vector3 } from "three";
import { usePlayback, world, type Selection } from "../store.ts";
import { anchorPosition, placementOf } from "./look.ts";

/** Where a selection is, and how far away to look at it from. */
export function selectionFocus(s: Selection): {
  target: Vector3;
  distance: number;
} {
  const at = (id: string) => {
    const p = placementOf(id);
    return p ? new Vector3(...p.position) : new Vector3();
  };
  switch (s.type) {
    case "part": {
      const p = placementOf(s.id);
      if (p?.shape === "island")
        return {
          target: at(s.id).setY(p.position[1] + 1),
          distance: Math.max(16, p.radius * 2.6),
        };
      return {
        target: anchorPosition(s.id).setY(anchorPosition(s.id).y - 1.2),
        distance: 14,
      };
    }
    case "row":
      return { target: at(s.table).setY(at(s.table).y + 0.6), distance: 7 };
    case "cargo":
      return { target: anchorPosition(s.holder), distance: 12 };
    case "movement": {
      const m = world.timeline.movements.find((x) => x.id === s.id);
      return { target: m ? anchorPosition(m.to) : new Vector3(), distance: 24 };
    }
    case "run": {
      const r = world.recording.runs.find((x) => x.id === s.id);
      return {
        target: r ? anchorPosition(r.function) : new Vector3(),
        distance: 40,
      };
    }
  }
}

const vec = (v: [number, number, number]) => new Vector3(...v);
const overview = {
  position: vec(world.layout.overview.position),
  target: vec(world.layout.overview.target),
};

const KEYS = new Set<string>();

/**
 * The free camera: orbit, pan and dolly with the pointer, fly with WASD
 * (Q and E for down and up). In director mode it follows the action until
 * the viewer takes over.
 */
export function CameraRig() {
  const controls = useRef<CameraControls>(null);
  const director = usePlayback((s) => s.director);
  const flight = usePlayback((s) => s.flight);
  const lastFocus = useRef<string | null>(null);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { position, target } = overview;
    void c.setLookAt(
      position.x,
      position.y,
      position.z,
      target.x,
      target.y,
      target.z,
      false,
    );
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      KEYS.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => KEYS.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // A requested flight: to the overview or to a selection.
  useEffect(() => {
    const c = controls.current;
    if (!c || !flight) return;
    if (flight.target === "overview") {
      const { position, target } = overview;
      void c.setLookAt(
        position.x,
        position.y,
        position.z,
        target.x,
        target.y,
        target.z,
        true,
      );
      return;
    }
    const { target, distance } = selectionFocus(flight.target);
    const from = new Vector3();
    c.getPosition(from);
    const offset = from.sub(target).normalize();
    // Keep a pleasant elevation whatever the current angle.
    offset.y = Math.max(offset.y, 0.45);
    offset.normalize().multiplyScalar(distance);
    void c.setLookAt(
      target.x + offset.x,
      target.y + offset.y,
      target.z + offset.z,
      target.x,
      target.y,
      target.z,
      true,
    );
  }, [flight]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    // Fly with the keyboard.
    const speed = (KEYS.has("shift") ? 120 : 36) * delta;
    const moves: [string, () => unknown][] = [
      ["w", () => c.forward(speed, false)],
      ["s", () => c.forward(-speed, false)],
      ["a", () => c.truck(-speed, 0, false)],
      ["d", () => c.truck(speed, 0, false)],
      ["e", () => c.elevate(speed, false)],
      ["q", () => c.elevate(-speed, false)],
    ];
    let moved = false;
    for (const [key, move] of moves) {
      if (KEYS.has(key)) {
        move();
        moved = true;
      }
    }
    if (moved && usePlayback.getState().director)
      usePlayback.getState().setDirector(false);

    if (!director) return;
    // Director: frame the subject of the current beat.
    const state = world.stateAt(usePlayback.getState().time);
    const focus = state.beat?.focus ?? null;
    const key = `${state.chapterIndex}:${focus}`;
    if (key === lastFocus.current) return;
    lastFocus.current = key;
    const target = focus ? anchorPosition(focus) : overview.target.clone();
    // Look at the subject from the front and above, near enough to read it.
    void c.setLookAt(
      target.x - 8,
      target.y + 26,
      target.z + 34,
      target.x,
      target.y,
      target.z,
      true,
    );
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.6}
      draggingSmoothTime={0.15}
      minDistance={3}
      maxDistance={Math.max(
        300,
        overview.position.distanceTo(overview.target) * 2,
      )}
      maxPolarAngle={Math.PI * 0.49}
      dollyToCursor
      onStart={() => {
        if (usePlayback.getState().director)
          usePlayback.getState().setDirector(false);
      }}
    />
  );
}
