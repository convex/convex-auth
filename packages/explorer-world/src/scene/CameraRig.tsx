import { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { Vector3 } from "three";
import { usePlayback, world, type Selection } from "../store.ts";
import { anchorPosition, type Layout } from "./layout.ts";

/** Where a selection is, and how far away to look at it from. */
export function selectionFocus(
  layout: Layout,
  s: Selection,
): { target: Vector3; distance: number } {
  switch (s.type) {
    case "region": {
      if (s.id === "platform")
        return { target: layout.platform.center.clone(), distance: 95 };
      const island = layout.islands.get(s.id);
      return {
        target: island
          ? island.center.clone().setY(island.center.y + 1)
          : new Vector3(),
        distance: (island?.radius ?? 8) * 3.2,
      };
    }
    case "function":
      return {
        target: anchorPosition(layout, s.id).setY(
          anchorPosition(layout, s.id).y - 1.4,
        ),
        distance: 13,
      };
    case "table": {
      const t = layout.tables.get(s.id);
      return {
        target: t ? t.position.clone() : new Vector3(),
        distance: t?.featured ? 15 : 11,
      };
    }
    case "row": {
      const t = layout.tables.get(s.table);
      return {
        target: t ? t.position.clone().setY(t.position.y + 0.5) : new Vector3(),
        distance: 7.5,
      };
    }
    case "place":
      return { target: anchorPosition(layout, s.id), distance: 18 };
    case "token": {
      const island = layout.islands.get(s.holder);
      return {
        target: island
          ? island.center.clone().setY(island.center.y + 4.4)
          : new Vector3(),
        distance: 12,
      };
    }
    case "movement": {
      const m = world.timeline.movements.find((x) => x.id === s.id);
      return {
        target: m ? anchorPosition(layout, m.to) : new Vector3(),
        distance: 22,
      };
    }
  }
}

const KEYS = new Set<string>();

/**
 * The free camera: orbit, pan and dolly with the pointer, fly with WASD
 * (Q and E for down and up). In director mode it follows the action until
 * the viewer takes over.
 */
export function CameraRig({ layout }: { layout: Layout }) {
  const controls = useRef<CameraControls>(null);
  const director = usePlayback((s) => s.director);
  const flight = usePlayback((s) => s.flight);
  const lastFocus = useRef<string | null>(null);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { position, target } = layout.overview;
    void c.setLookAt(
      position.x,
      position.y,
      position.z,
      target.x,
      target.y,
      target.z,
      false,
    );
  }, [layout]);

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
      const { position, target } = layout.overview;
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
    const { target, distance } = selectionFocus(layout, flight.target);
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
  }, [flight, layout]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    // Fly with the keyboard.
    const speed = (KEYS.has("shift") ? 60 : 24) * delta;
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
    const target = focus
      ? anchorPosition(layout, focus)
      : layout.overview.target.clone();
    const overview = layout.overview.target;
    // Look between the subject and the middle of the world, from the front.
    target.lerp(overview, 0.35);
    void c.setLookAt(
      target.x - 14,
      target.y + 30,
      target.z + 42,
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
      maxDistance={220}
      maxPolarAngle={Math.PI * 0.49}
      dollyToCursor
      onStart={() => {
        if (usePlayback.getState().director)
          usePlayback.getState().setDirector(false);
      }}
    />
  );
}
