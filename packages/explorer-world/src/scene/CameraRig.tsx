import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import {
  PerspectiveCamera,
  Plane,
  type Mesh,
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
 * right-drag orbits about the point looked at; the wheel arrives at what it
 * points at; WASD flies (Q and E for down and up). Nothing ties the camera to a
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
  const scene = useThree((s) => s.scene);
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
    // The wheel zooms about the thing under the pointer, as on the stage
    // (`stage/Camera.tsx`): what the pointer is on stays under it, the
    // camera stops with all of it in view, and close to it turns to look
    // down into it. Over the sky it zooms straight in or out.
    const wheel = (e: WheelEvent) => {
      const c = controls.current;
      if (!c) return;
      e.preventDefault();
      takeOver();
      // Trackpads send small deltas, mice large ones; lines count as 40 px.
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      let k = Math.exp(Math.max(-600, Math.min(600, dy)) * 0.0016);
      const pos = c.getPosition(new Vector3(), true);
      const target = c.getTarget(new Vector3(), true);
      const r = canvas.getBoundingClientRect();
      ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      ray.ray.origin.copy(pos);
      const hit = ray
        .intersectObjects(scene.children, true)
        .find(
          (h) => (h.object as { isMesh?: boolean }).isMesh && shown(h.object),
        );
      let thing: { centre: Vector3; radius: number } | null = null;
      let least = ZOOM.min;
      if (hit) {
        const g = (hit.object as Mesh).geometry;
        if (g && !g.boundingSphere) g.computeBoundingSphere();
        const sphere = g?.boundingSphere;
        const scale = hit.object.getWorldScale(new Vector3());
        const radius =
          (sphere?.radius ?? 0) * Math.max(scale.x, scale.y, scale.z);
        if (sphere && radius > 0 && radius < ARRIVE.most) {
          thing = {
            centre: hit.object.localToWorld(sphere.center.clone()),
            radius,
          };
          least = Math.max(ZOOM.min, radius * ARRIVE.stop);
        }
      }
      // Only what is about as near as the point looked at: low over the
      // ground the pointer meets things far off, and zooming toward them
      // would glide across the world.
      const reach = c.distance * 1.5;
      if (hit && hit.distance > reach) thing = null;
      if (!thing) least = ZOOM.min;
      let about: Vector3 | null = hit && thing ? hit.point.clone() : null;
      if (!about) {
        const h = surfaceHeight(ray.ray.origin, ray.ray.direction);
        ground.constant = -h;
        const g =
          ray.ray.direction.y < -1e-3
            ? ray.ray.intersectPlane(ground, new Vector3())
            : null;
        about = g && g.distanceTo(pos) < reach ? g : target;
      }
      const d = pos.distanceTo(about);
      if (k < 1 && d <= least) return;
      k = Math.min(
        Math.max(k, least / Math.max(d, 1e-6)),
        c.maxDistance / Math.max(d, 1e-6),
      );
      const p = about.clone().add(pos.clone().sub(about).multiplyScalar(k));
      const t = about.clone().add(target.clone().sub(about).multiplyScalar(k));
      // Near the end of an approach to a thing, look down into it.
      if (thing && k < 1) {
        const d1 = p.distanceTo(about);
        const near = Math.min(
          1,
          Math.max(
            0,
            (thing.radius * ARRIVE.from - d1) /
              (thing.radius * (ARRIVE.from - 1)),
          ),
        );
        if (near > 0) {
          const v = p.clone().sub(about);
          const len = v.length();
          const el = Math.asin(Math.min(1, Math.max(-1, v.y / len)));
          const want = (ARRIVE.elevation * Math.PI) / 180;
          const el2 = el + (want - el) * Math.min(1, near * ARRIVE.rate);
          const flat = new Vector3(v.x, 0, v.z);
          if (flat.lengthSq() < 1e-9) flat.set(0, 0, 1);
          flat.normalize().multiplyScalar(Math.cos(el2) * len);
          p.copy(about)
            .add(flat)
            .add(new Vector3(0, Math.sin(el2) * len, 0));
          t.lerp(thing.centre, Math.min(1, near * ARRIVE.rate));
        }
      }
      // Never into the surface below the camera.
      const below = surfaceHeight(
        new Vector3(p.x, 1e4, p.z),
        new Vector3(0, -1, 0),
      );
      if (p.y < below + 0.4 || p.y < about.y + 0.4) return;
      void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, true);
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [canvas, camera, scene]);

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
        // The wheel is handled above: it arrives at what it points at.
        wheel: ACTION.NONE,
      }}
      minDistance={3}
      // Far enough to see the whole map from any side.
      maxDistance={Math.max(
        600,
        overview.position.distanceTo(overview.target) * 4,
      )}
      maxPolarAngle={Math.PI * 0.49}
      onStart={takeOver}
    />
  );
}

/** The wheel's nearest approach to the point under it. */
const ZOOM = { min: 3 };
/**
 * How the wheel arrives at a thing (as on the stage): within `from` times
 * its radius each notch turns the camera `rate` of the way toward looking
 * down at `elevation` degrees; things larger than `most` (an island's
 * floor) are not arrived at; zooming in stops `stop` times its radius
 * from it.
 */
const ARRIVE = { from: 5, elevation: 55, rate: 0.45, most: 150, stop: 1.15 };

function shown(o: { visible: boolean; parent: unknown }): boolean {
  for (let x: typeof o | null = o; x; x = x.parent as typeof o | null)
    if (!x.visible) return false;
  return true;
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
