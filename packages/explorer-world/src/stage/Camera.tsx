import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import {
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera,
} from "three";
import { DEFAULT_VIEW, SCREEN, ZOOM } from "./layout.ts";
import { useStage } from "./store.ts";

const { ACTION } = CameraControlsImpl;
const KEYS = new Set<string>();

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

/**
 * Where to stand to face the screen squarely, with all of it in view and a
 * small margin: close enough to read and type.
 */
export function screenPose(camera: PerspectiveCamera): {
  position: Vector3;
  target: Vector3;
} {
  const half = ((camera.fov / 2) * Math.PI) / 180;
  const margin = 1.06;
  const h = SCREEN.height;
  const w = SCREEN.width;
  const d =
    Math.max(h / 2 / Math.tan(half), w / 2 / (Math.tan(half) * camera.aspect)) *
    margin;
  const target = new Vector3(...SCREEN.center);
  return { position: target.clone().add(new Vector3(0, 0, d)), target };
}

/**
 * The camera of the stage, as in the islands world (`scene/CameraRig.tsx`):
 * a plain drag pans and keeps the point of the floor pressed under the
 * pointer; Cmd-drag, Ctrl-drag or right-drag orbits; the wheel zooms toward
 * the cursor; W A S D flies, Q and E down and up. It also flies to the screen
 * and back when asked (`useStage().fly`). The pointer over the screen uses
 * the page, not the camera.
 */
export function StageCamera() {
  const controls = useRef<CameraControls>(null);
  const flight = useStage((s) => s.flight);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  // The element R3F and the controls listen on: the canvas lets the pointer
  // through to the page on the screen, so they listen on its container.
  const surface = useThree(
    (s) => (s.events.connected as HTMLElement | undefined) ?? s.gl.domElement,
  );

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    (globalThis as { explorerControls?: unknown }).explorerControls = c;
    (globalThis as { explorerCamera?: unknown }).explorerCamera = camera;
    const [px, py, pz] = DEFAULT_VIEW.position;
    const [tx, ty, tz] = DEFAULT_VIEW.target;
    void c.setLookAt(px, py, pz, tx, ty, tz, false);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      KEYS.add(e.key.toLowerCase());
    };
    const up = (e: KeyboardEvent) => {
      KEYS.delete(e.key.toLowerCase());
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

  // A plain drag pans, holding the floor under the pointer.
  useEffect(() => {
    let pressed: Vector3 | null = null;
    let id = -1;
    const press = (e: PointerEvent) => {
      const c = controls.current;
      if (!c || e.button !== 0) return;
      const orbit = e.metaKey || e.ctrlKey;
      c.mouseButtons.left = orbit ? ACTION.ROTATE : ACTION.NONE;
      if (orbit || e.pointerType === "touch") return;
      pressed = groundUnder(c, camera, surface, e.clientX, e.clientY);
      id = e.pointerId;
    };
    const move = (e: PointerEvent) => {
      const c = controls.current;
      if (!c || !pressed || e.pointerId !== id) return;
      const now = groundUnder(c, camera, surface, e.clientX, e.clientY);
      if (!now) return;
      const step = pressed.clone().sub(now);
      const most = c.distance * 0.5;
      if (step.length() > most) step.setLength(most);
      const t = c.getTarget(new Vector3(), true).add(step);
      void c.moveTo(t.x, t.y, t.z, false);
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId === id) pressed = null;
    };
    surface.addEventListener("pointerdown", press, { capture: true });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      surface.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [surface, camera]);

  // A requested flight: to the screen, or back to the default view.
  useEffect(() => {
    const c = controls.current;
    if (!c || flight === 0) return;
    const { view } = useStage.getState();
    if (view === "screen") {
      const { position: p, target: t } = screenPose(camera);
      void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, true);
    } else {
      const [px, py, pz] = DEFAULT_VIEW.position;
      const [tx, ty, tz] = DEFAULT_VIEW.target;
      void c.setLookAt(px, py, pz, tx, ty, tz, true);
    }
  }, [flight, camera]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    // From a metre to kilometres: the depth range follows the distance, and
    // so do the speeds.
    const near = Math.max(0.05, c.distance / 400);
    const far = Math.max(20_000, c.distance * 60);
    if (Math.abs(camera.near - near) > near * 0.05 || camera.far !== far) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    const speed =
      (KEYS.has("shift") ? 2.4 : 0.7) * Math.max(c.distance, 2) * delta;
    if (KEYS.has("w")) void c.forward(speed, false);
    if (KEYS.has("s")) void c.forward(-speed, false);
    if (KEYS.has("a")) void c.truck(-speed, 0, false);
    if (KEYS.has("d")) void c.truck(speed, 0, false);
    if (KEYS.has("e")) void c.elevate(speed, false);
    if (KEYS.has("q")) void c.elevate(-speed, false);
  });

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.6}
      draggingSmoothTime={0.15}
      mouseButtons={{
        left: ACTION.NONE,
        middle: ACTION.DOLLY,
        right: ACTION.ROTATE,
        wheel: ACTION.DOLLY,
      }}
      minDistance={ZOOM.min}
      maxDistance={ZOOM.max}
      maxPolarAngle={Math.PI * 0.49}
      dollyToCursor
    />
  );
}

const ray = new Raycaster();
const ndc = new Vector2();
const floor = new Plane(new Vector3(0, 1, 0), 0);

/** The point of the floor (y = 0) under the pointer, or null at the sky. */
function groundUnder(
  c: CameraControlsImpl,
  camera: Camera,
  surface: HTMLElement,
  x: number,
  y: number,
): Vector3 | null {
  const r = surface.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  c.getPosition(ray.ray.origin, true);
  if (ray.ray.direction.y > -1e-3) return null;
  const hit = ray.ray.intersectPlane(floor, new Vector3());
  if (!hit || hit.distanceTo(ray.ray.origin) > c.distance * 50) return null;
  return hit;
}
