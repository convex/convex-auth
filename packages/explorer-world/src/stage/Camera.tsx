import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import {
  Box3,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera,
} from "three";
import { DEFAULT_VIEW, HOME_FIT, SCREEN, WORLD, ZOOM } from "./layout.ts";
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
 * The default view, fitted to the window: from the direction of
 * `DEFAULT_VIEW`, as near as it can be with the screen and the whole
 * territory in view at the window's aspect.
 */
export function homePose(camera: PerspectiveCamera): {
  position: Vector3;
  target: Vector3;
} {
  const target = new Vector3(...DEFAULT_VIEW.target);
  const from = new Vector3(...DEFAULT_VIEW.position);
  const dir = from.clone().sub(target);
  const base = dir.length();
  dir.normalize();
  const probe = camera.clone();
  const fits = (k: number) => {
    probe.position.copy(target).addScaledVector(dir, k);
    probe.lookAt(target);
    probe.updateMatrixWorld();
    probe.updateProjectionMatrix();
    return HOME_FIT.every(([x, y, z]) => {
      const v = new Vector3(x, y, z).project(probe);
      return Math.abs(v.x) <= 0.94 && v.y <= 0.94 && v.y >= -0.86 && v.z < 1;
    });
  };
  let k = base;
  while (!fits(k) && k < base * 6) k *= 1.04;
  return { position: target.clone().addScaledVector(dir, k), target };
}

const raycaster = new Raycaster();

/**
 * How the wheel arrives at a thing: within `from` times its radius, each
 * notch turns the camera `rate` of the way (times how near it is) toward
 * looking down at `elevation` degrees, into the thing. Things larger than
 * `most` (the ground, the screen's wall) are not arrived at. Zooming in
 * stops `stop` times the radius from the point, with all of the thing in
 * view.
 */
const ARRIVE = { from: 5, elevation: 55, rate: 0.45, most: 150, stop: 1.15 };

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
  /** Whether the viewer moved the camera since it was last sent home. */
  const moved = useRef(false);
  const scene = useThree((s) => s.scene);
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
    (globalThis as { explorerScene?: unknown }).explorerScene = scene;
    // The point looked at stays over the world, never under the ground; the
    // camera stays above the point it looks at (maxPolarAngle).
    c.setBoundary(
      new Box3(
        new Vector3(-WORLD.extent, 0, -WORLD.extent),
        new Vector3(WORLD.extent, WORLD.height, WORLD.extent),
      ),
    );
    const { position: p, target: t } = homePose(camera);
    void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
    // The window can change its shape: the default view fits it again
    // while the camera is there.
    const resize = () => {
      if (useStage.getState().view !== "default" || moved.current) return;
      const home = homePose(camera);
      void c.setLookAt(
        home.position.x,
        home.position.y,
        home.position.z,
        home.target.x,
        home.target.y,
        home.target.z,
        false,
      );
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "h") {
        useStage.getState().fly("default");
        return;
      }
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
      moved.current = true;
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

  // The wheel zooms about the point under the pointer: the thing the pointer
  // is on stays under it, and the camera never passes it. Over the sky, it
  // zooms straight in or out, moving nothing sideways.
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      const c = controls.current;
      if (!c) return;
      e.preventDefault();
      moved.current = true;
      // Trackpads send small deltas, mice large ones; lines count as 40 px.
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      let k = Math.exp(Math.max(-600, Math.min(600, dy)) * 0.0016);
      const pos = c.getPosition(new Vector3(), true);
      const target = c.getTarget(new Vector3(), true);
      const r = surface.getBoundingClientRect();
      ndc.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      raycaster.ray.origin.copy(pos);
      const hit = raycaster
        .intersectObjects(scene.children, true)
        .find(
          (h) =>
            (h.object as { isMesh?: boolean }).isMesh === true &&
            shown(h.object),
        );
      let about: Vector3 | null = hit ? hit.point : null;
      // Zooming in arrives at the thing under the pointer and stops there,
      // with all of it in view, rather than pressing into its surface: the
      // least distance grows with its size (the ground and the wall count
      // as large things seen from a moderate height).
      let least = ZOOM.min;
      /** The thing zoomed toward: its centre and radius (not the ground). */
      let thing: { centre: Vector3; radius: number } | null = null;
      if (hit) {
        const g = (
          hit.object as {
            geometry?: {
              boundingSphere: unknown;
              computeBoundingSphere(): void;
            };
          }
        ).geometry;
        if (g && !g.boundingSphere) g.computeBoundingSphere();
        const sphere = g?.boundingSphere as { radius: number } | undefined;
        const scale = hit.object.getWorldScale(new Vector3());
        const r = (sphere?.radius ?? 0) * Math.max(scale.x, scale.y, scale.z);
        least = Math.max(ZOOM.min, Math.min(r, 160) * ARRIVE.stop);
        const sc = (sphere as { center?: Vector3 } | undefined)?.center;
        if (r > 0 && r < ARRIVE.most && sc)
          thing = {
            centre: hit.object.localToWorld(sc.clone()),
            radius: r,
          };
      }
      if (!about) {
        const g = raycaster.ray.intersectPlane(floor, new Vector3());
        about = g && g.distanceTo(pos) < ZOOM.max ? g : null;
      }
      if (!about) about = target;
      // Keep within the zoom range: no nearer than the least distance to
      // the point, no farther than the most.
      const d = pos.distanceTo(about);
      if (k < 1 && d <= least) return;
      k = Math.min(
        Math.max(k, least / Math.max(d, 1e-6)),
        ZOOM.max / Math.max(d, 1e-6),
      );
      const p = about.clone().add(pos.clone().sub(about).multiplyScalar(k));
      const t = about.clone().add(target.clone().sub(about).multiplyScalar(k));
      // Near the end of an approach to a thing, look down into it: the
      // camera turns about the point toward ARRIVE.elevation, and the point
      // looked at moves toward the thing's centre.
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
          const e = el + (want - el) * Math.min(1, near * ARRIVE.rate);
          const flat = new Vector3(v.x, 0, v.z);
          if (flat.lengthSq() < 1e-9) flat.set(0, 0, 1);
          flat.normalize().multiplyScalar(Math.cos(e) * len);
          p.copy(about)
            .add(flat)
            .add(new Vector3(0, Math.sin(e) * len, 0));
          t.lerp(thing.centre, Math.min(1, near * ARRIVE.rate));
        }
      }
      // Never below the ground.
      if (p.y < 0.4) return;
      t.y = Math.max(0, t.y);
      void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, true);
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, [surface, camera, scene]);

  // A requested flight: to the screen, or back to the default view.
  useEffect(() => {
    const c = controls.current;
    if (!c || flight === 0) return;
    const { view } = useStage.getState();
    if (view === "screen") {
      const { position: p, target: t } = screenPose(camera);
      void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, true);
    } else {
      moved.current = false;
      const { position: p, target: t } = homePose(camera);
      void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, true);
    }
  }, [flight, camera]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    // From a metre to kilometres: the depth range follows the distance, and
    // so do the speeds.
    const near = Math.max(0.05, c.distance / 400);
    const far = Math.max(60_000, c.distance * 60);
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
        // The wheel zooms about the pointer's point (above).
        wheel: ACTION.NONE,
      }}
      minDistance={ZOOM.min}
      maxDistance={ZOOM.max}
      maxPolarAngle={Math.PI * 0.49}
    />
  );
}

const ray = new Raycaster();
const ndc = new Vector2();

/** Whether an object is drawn: it and every group around it are visible. */
function shown(o: { visible: boolean; parent: unknown }): boolean {
  for (let x: typeof o | null = o; x; x = x.parent as typeof o | null)
    if (!x.visible) return false;
  return true;
}
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
