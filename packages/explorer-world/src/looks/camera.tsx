/**
 * The camera of the gallery, as in the world (`../scene/CameraRig.tsx`): a
 * plain drag pans with the point of the ground pressed kept under the
 * pointer, Cmd-, Ctrl- or right-drag orbits, the wheel zooms toward the
 * cursor. Every canvas of the gallery shares one pose, so a change of look
 * keeps the camera where it is and the contact sheet shows every look from
 * the same place.
 */
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
import { create } from "zustand";
import { START_VIEW, type V3 } from "./layout.ts";

type Pose = {
  position: V3;
  target: V3;
  /** The canvas that set it, or -1 for a jump from outside. */
  by: number;
  /** Move there over a moment rather than at once. */
  smooth?: boolean;
  version: number;
};

/** A pose shared by the canvases of one scene. */
export function createPose(start: { position: V3; target: V3 }) {
  return create<Pose & { set: (p: Omit<Pose, "version">) => void }>((set) => ({
    ...start,
    by: -1,
    version: 0,
    set: (p) => set((s) => ({ ...p, version: s.version + 1 })),
  }));
}
export type PoseStore = ReturnType<typeof createPose>;

/** The pose of the small sample. */
export const usePose = createPose(START_VIEW);
const defaultPose = usePose;

const { ACTION } = CameraControlsImpl;
let nextId = 0;

export function GalleryCamera({
  pose: usePose = defaultPose,
  minDistance = 4,
  maxDistance = 160,
  vast = false,
}: {
  pose?: PoseStore;
  minDistance?: number;
  maxDistance?: number;
  /**
   * A scene of kilometres seen from metres: the near and far planes follow
   * the distance to the point looked at, which keeps the depth precise at
   * every level.
   */
  vast?: boolean;
}) {
  const controls = useRef<CameraControls>(null);
  const id = useRef(nextId++);
  const seen = useRef(-1);
  /** Set once the controls hold the shared pose: until then, publish nothing. */
  const ready = useRef(false);
  const canvas = useThree((s) => s.gl.domElement);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);

  // Start where the shared pose is.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { position: p, target: t, version } = usePose.getState();
    void c.setLookAt(...p, ...t, false);
    seen.current = version;
    ready.current = true;
    (globalThis as { looksControls?: unknown }).looksControls = c;
  }, []);

  // Follow the pose when another canvas moves it.
  useEffect(
    () =>
      usePose.subscribe((s) => {
        const c = controls.current;
        if (!c || s.by === id.current || s.version === seen.current) return;
        seen.current = s.version;
        void c.setLookAt(...s.position, ...s.target, Boolean(s.smooth));
        invalidate();
      }),
    [invalidate, usePose],
  );

  // Publish the pose as this canvas's camera moves.
  useFrame(() => {
    const c = controls.current;
    if (!c || !ready.current) return;
    if (vast) {
      const near = Math.min(40, Math.max(0.05, c.distance * 0.02));
      const far = Math.max(9000, c.distance * 8);
      if (
        Math.abs(camera.near - near) > near * 0.05 ||
        Math.abs(camera.far - far) > far * 0.05
      ) {
        camera.near = near;
        camera.far = far;
        (camera as PerspectiveCamera).updateProjectionMatrix();
      }
    }
    const p = c.getPosition(new Vector3(), true).toArray() as V3;
    const t = c.getTarget(new Vector3(), true).toArray() as V3;
    const s = usePose.getState();
    const same = (a: V3, b: V3) => a.every((x, i) => Math.abs(x - b[i]) < 1e-4);
    if (same(p, s.position) && same(t, s.target)) return;
    usePose.getState().set({ position: p, target: t, by: id.current });
    seen.current = usePose.getState().version;
  });

  // A plain drag pans, holding the ground under the pointer.
  useEffect(() => {
    let pressed: Vector3 | null = null;
    let pointer = -1;
    const press = (e: PointerEvent) => {
      const c = controls.current;
      if (!c || e.button !== 0) return;
      const orbit = e.metaKey || e.ctrlKey;
      c.mouseButtons.left = orbit ? ACTION.ROTATE : ACTION.NONE;
      if (orbit || e.pointerType === "touch") return;
      pressed = groundUnder(c, camera, canvas, e.clientX, e.clientY);
      pointer = e.pointerId;
    };
    const move = (e: PointerEvent) => {
      const c = controls.current;
      if (!c || !pressed || e.pointerId !== pointer) return;
      const now = groundUnder(c, camera, canvas, e.clientX, e.clientY);
      if (!now) return;
      const step = pressed.clone().sub(now);
      const most = c.distance * 0.5;
      if (step.length() > most) step.setLength(most);
      const t = c.getTarget(new Vector3(), true).add(step);
      void c.moveTo(t.x, t.y, t.z, false);
      invalidate();
    };
    const release = (e: PointerEvent) => {
      if (e.pointerId === pointer) pressed = null;
    };
    canvas.addEventListener("pointerdown", press, { capture: true });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      canvas.removeEventListener("pointerdown", press, { capture: true });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [canvas, camera, invalidate]);

  return (
    <CameraControls
      ref={controls}
      makeDefault
      smoothTime={0.4}
      draggingSmoothTime={0.12}
      mouseButtons={{
        left: ACTION.NONE,
        middle: ACTION.DOLLY,
        right: ACTION.ROTATE,
        wheel: ACTION.DOLLY,
      }}
      minDistance={minDistance}
      maxDistance={maxDistance}
      maxPolarAngle={Math.PI * 0.49}
      dollyToCursor
    />
  );
}

const ray = new Raycaster();
const ndc = new Vector2();
const ground = new Plane(new Vector3(0, 1, 0), 0);

function groundUnder(
  c: CameraControlsImpl,
  camera: Camera,
  canvas: HTMLElement,
  x: number,
  y: number,
): Vector3 | null {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  c.getPosition(ray.ray.origin, true);
  if (ray.ray.direction.y > -1e-3) return null;
  const hit = ray.ray.intersectPlane(ground, new Vector3());
  if (!hit || hit.distanceTo(ray.ray.origin) > c.distance * 50) return null;
  return hit;
}
