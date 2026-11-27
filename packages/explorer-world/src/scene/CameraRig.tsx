import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import {
  PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
} from "three";
import { currentState, usePlayback, world, type Selection } from "../store.ts";
import { frameRegion, homeRect } from "./homeFrame.ts";
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
    case "op": {
      // The middle of the places it went through.
      const o = world.timeline.ops.find((x) => x.id === s.id);
      const target = new Vector3();
      for (const p of o?.points ?? []) target.add(anchorPosition(p.anchor));
      if (o?.points.length) target.divideScalar(o.points.length);
      return { target, distance: 30 };
    }
  }
}

const vec = (v: [number, number, number]) => new Vector3(...v);
// Read from the world each time: a live recording can lay the map out again.
const overview = {
  get position() {
    return vec(world.layout.overview.position);
  },
  get target() {
    return vec(world.layout.overview.target);
  },
};

/**
 * Home: the browser region with the world beyond it, else the overview.
 * Fitted to the window: the whole region clear of the panel over the
 * canvas (see `homeFrame.ts`).
 */
function home(
  camera: Camera,
  canvas: HTMLElement,
): { position: Vector3; target: Vector3 } {
  const h = world.layout.home;
  if (!h) return overview;
  const box = canvas.getBoundingClientRect();
  if (!(camera instanceof PerspectiveCamera) || !box.width || !box.height)
    return { position: vec(h.position), target: vec(h.target) };
  const el = document.querySelector(".controls");
  const r = el?.getBoundingClientRect();
  const panel =
    r && r.width && r.height
      ? {
          left: r.left - box.left,
          right: r.right - box.left,
          top: r.top - box.top,
          bottom: r.bottom - box.top,
        }
      : null;
  const platform = world.layout.platform.center;
  const direction = vec(h.position).sub(vec(h.target)).normalize();
  const rect = homeRect(
    box.width,
    box.height,
    panel,
    BOTTOM_BAR,
    platform[0] >= h.region.center[0],
    // A circle on the ground seen from above at this elevation.
    1 / Math.max(0.2, direction.y),
  );
  return frameRegion(
    h.region,
    direction,
    camera.fov,
    box.width,
    box.height,
    rect,
  );
}

/** The height of the time line along the bottom of the window (px). */
const BOTTOM_BAR = 44;

const KEYS = new Set<string>();

/** Seconds of playback during which Follow keeps the overview. */
const START_AFTER = 2.5;
/** The direction Follow looks from: in front and above. */
const VIEW = new Vector3(-0.18, 0.66, 0.73).normalize();

const { ACTION } = CameraControlsImpl;

/** A key typed into a field, not meant for the camera. */
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.isContentEditable ||
      t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT")
  );
};

/** Whether the camera is at Home as it opened or was flown there. */
let atHome = false;

/** The viewer takes the camera: Follow stops until turned on again. */
const takeOver = () => {
  atHome = false;
  if (usePlayback.getState().director)
    usePlayback.getState().setDirector(false);
};

/**
 * The free camera. Drag pans across the map; Cmd-drag, Ctrl-drag or
 * right-drag orbits about the point looked at; the wheel zooms toward the
 * cursor; WASD flies (Q and E for down and up). Nothing ties the camera to a
 * region: it moves on its own only for Overview, Follow and Fly to. In
 * director mode (Follow) it follows the action until the viewer takes over.
 */
export function CameraRig() {
  const controls = useRef<CameraControls>(null);
  const director = usePlayback((s) => s.director);
  const flight = usePlayback((s) => s.flight);
  const lastFocus = useRef<string | null>(null);

  const canvas = useThree((s) => s.gl.domElement);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    // For scripted checks: to look from chosen places.
    (globalThis as { explorerControls?: unknown }).explorerControls = c;
    // The world opens at Home, and stays fitted to the window and the
    // panel until the viewer moves the camera.
    const fit = (smooth: boolean) => {
      const { position, target } = home(camera, canvas);
      void c.setLookAt(
        position.x,
        position.y,
        position.z,
        target.x,
        target.y,
        target.z,
        smooth,
      );
    };
    fit(false);
    atHome = true;
    const refit = () => {
      if (atHome) fit(false);
    };
    const seen = new ResizeObserver(refit);
    seen.observe(canvas);
    // The panel comes, and changes size, after the canvas.
    const panel = () => document.querySelector(".controls");
    let watched: Element | null = null;
    const watch = setInterval(() => {
      const el = panel();
      if (el && el !== watched) {
        if (watched) seen.unobserve(watched);
        seen.observe(el);
        watched = el;
      }
    }, 500);
    return () => {
      seen.disconnect();
      clearInterval(watch);
    };
  }, [camera, canvas]);

  // The keys are read on the window: the canvas need not have focus.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      KEYS.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => {
      KEYS.delete(e.key.toLowerCase());
      // With Cmd held, macOS sends no keyup for the other keys.
      if (e.key === "Meta") KEYS.clear();
    };
    const clear = () => KEYS.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // A plain drag pans: the point of the ground pressed stays under the
  // pointer, as on a map. With Cmd or Ctrl the controls orbit instead.
  useEffect(() => {
    let pressed: Vector3 | null = null;
    let id = -1;
    const press = (e: PointerEvent) => {
      const c = controls.current;
      if (!c || e.button !== 0) return;
      const orbit = e.metaKey || e.ctrlKey;
      c.mouseButtons.left = orbit ? ACTION.ROTATE : ACTION.NONE;
      if (orbit || e.pointerType === "touch") return;
      pressed = groundUnder(c, camera, canvas, e.clientX, e.clientY);
      id = e.pointerId;
      if (pressed) takeOver();
    };
    const move = (e: PointerEvent) => {
      const c = controls.current;
      if (!c || !pressed || e.pointerId !== id) return;
      const now = groundUnder(
        c,
        camera,
        canvas,
        e.clientX,
        e.clientY,
        pressed.y,
      );
      if (!now) return;
      // Exactly the way to the pressed point: a cap here would leave it
      // behind the pointer close in. Near the horizon `groundUnder` finds
      // no point, so the camera does not jump.
      const step = pressed.clone().sub(now);
      const t = c.getTarget(new Vector3(), true).add(step);
      void c.moveTo(t.x, t.y, t.z, false);
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId === id) pressed = null;
    };
    canvas.addEventListener("pointerdown", press, { capture: true });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    // The wheel zooms without a "control start": it takes over here.
    canvas.addEventListener("wheel", takeOver, { passive: true });
    return () => {
      canvas.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      canvas.removeEventListener("wheel", takeOver);
    };
  }, [canvas, camera]);

  // A requested flight: to the overview or to a selection.
  useEffect(() => {
    const c = controls.current;
    if (!c || !flight) return;
    if (flight.target === "overview" || flight.target === "home") {
      const { position, target } =
        flight.target === "home" ? home(camera, canvas) : overview;
      atHome = flight.target === "home";
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
    atHome = false;
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
  }, [flight, camera, canvas]);

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
    if (moved) takeOver();

    if (!director) return;
    atHome = false;
    // Director: frame every part the current beat touches. The world is shown
    // whole from above first; the director starts after the first moments.
    const { time } = usePlayback.getState();
    if (time < START_AFTER) {
      if (lastFocus.current !== null && lastFocus.current !== "overview") {
        const { position: p, target: q } = overview;
        void c.setLookAt(p.x, p.y, p.z, q.x, q.y, q.z, true);
      }
      lastFocus.current = "overview";
      return;
    }
    const state = currentState();
    const frame = state.beat?.frame ?? [];
    const key = `${state.chapterIndex}:${frame.join(",")}`;
    if (key === lastFocus.current) return;
    lastFocus.current = key;
    if (!frame.length) return;
    const points = frame.map((id) => anchorPosition(id));
    const target = points
      .reduce((sum, p) => sum.add(p), new Vector3())
      .multiplyScalar(1 / points.length);
    const spread = Math.max(...points.map((p) => p.distanceTo(target)));
    const distance = Math.min(320, Math.max(24, spread * 2.3 + 16));
    const at = VIEW.clone().multiplyScalar(distance).add(target);
    void c.setLookAt(at.x, at.y, at.z, target.x, target.y, target.z, true);
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.6}
      draggingSmoothTime={0.15}
      mouseButtons={{
        // A plain drag pans by hand (above); Cmd or Ctrl sets ROTATE.
        left: ACTION.NONE,
        middle: ACTION.DOLLY,
        right: ACTION.ROTATE,
        wheel: ACTION.DOLLY,
      }}
      minDistance={3}
      // Far enough to see the whole map from any side.
      maxDistance={Math.max(
        600,
        overview.position.distanceTo(overview.target) * 4,
      )}
      maxPolarAngle={Math.PI * 0.49}
      dollyToCursor
      onStart={takeOver}
    />
  );
}

const ray = new Raycaster();
const ndc = new Vector2();
const ground = new Plane(new Vector3(0, 1, 0), 0);

/**
 * The height of the surface a ray from the camera meets first: the top of
 * the highest island whose disc it crosses, else the ground (y = 0). The
 * islands stand at different heights (a client region above the ground).
 */
export function surfaceHeight(origin: Vector3, direction: Vector3): number {
  let best = 0;
  if (direction.y > -1e-3) return best;
  for (const i of world.layout.islands) {
    const h = i.position[1];
    if (h <= best) continue;
    const t = (h - origin.y) / direction.y;
    if (t <= 0) continue;
    const x = origin.x + direction.x * t - i.position[0];
    const z = origin.z + direction.z * t - i.position[2];
    if (x * x + z * z <= i.radius * i.radius) best = h;
  }
  return best;
}

/**
 * The point of the surface under the pointer, seen from where the controls
 * will put the camera, or null when the pointer looks at the sky. A drag
 * keeps to the height it was pressed at (`height`); without one, the
 * surface under the pointer.
 */
function groundUnder(
  c: CameraControlsImpl,
  camera: Camera,
  canvas: HTMLElement,
  x: number,
  y: number,
  height?: number,
): Vector3 | null {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  // The camera turns only when it orbits; it moves with each step of a pan,
  // so the ray starts where the controls hold it, not where it was drawn.
  ray.setFromCamera(ndc, camera);
  c.getPosition(ray.ray.origin, true);
  if (ray.ray.direction.y > -1e-3) return null;
  ground.constant = -(
    height ?? surfaceHeight(ray.ray.origin, ray.ray.direction)
  );
  const hit = ray.ray.intersectPlane(ground, new Vector3());
  if (!hit || hit.distanceTo(ray.ray.origin) > c.distance * 50) return null;
  return hit;
}
