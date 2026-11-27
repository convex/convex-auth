/**
 * Diagnostics for a scene that draws wrong on one machine and right on the
 * others. `?diag` shows them on screen (`src/ui/DiagPanel.tsx`): the GPU and
 * what it supports, the size of the canvas, the camera, the count of
 * non-finite pixels in the scene buffer, and a switch for each effect and each
 * layer of the scene. Scripted checks call the same scan through
 * `window.explorerDiag`.
 */
import {
  DataUtils,
  FloatType,
  HalfFloatType,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type TextureDataType,
  type WebGLRenderer,
} from "three";
import { create } from "zustand";

/** The layers of the scene, each a named group that can be hidden. */
export const LAYERS = [
  "stars",
  "sparkles",
  "platform",
  "islands",
  "parts",
  "rows",
  "links",
  "labels",
  "travellers",
] as const;
export type LayerName = (typeof LAYERS)[number];

export const layerGroupName = (layer: LayerName) => `layer:${layer}`;

export interface Scan {
  /** The type of the buffer drawn into: the composer draws into half floats. */
  type: "half" | "float";
  width: number;
  height: number;
  /** NaN or infinite in any channel. */
  nonFinite: number;
  /** A finite negative value in any color channel. */
  negative: number;
  /** A finite value above 64, far brighter than anything the scene means. */
  huge: number;
  /** The box of the non-finite pixels, in buffer pixels from the bottom left. */
  box: [number, number, number, number] | null;
  /** The extremes of the finite color values. */
  min: number;
  max: number;
  ms: number;
}

interface Diag {
  /** `?diag` in the URL: the panel shows. */
  open: boolean;
  layers: Record<LayerName, boolean>;
  fog: boolean;
  bloom: boolean;
  vignette: boolean;
  /** Replaces non-finite and negative values before the bloom. */
  sanitize: boolean;
  scan: Scan | null;
  toggle: (
    key: LayerName | "fog" | "bloom" | "vignette" | "sanitize",
    on?: boolean,
  ) => void;
}

const params = new URLSearchParams(location.search);

export const useDiag = create<Diag>((set) => ({
  open: params.has("diag"),
  layers: Object.fromEntries(LAYERS.map((l) => [l, true])) as Record<
    LayerName,
    boolean
  >,
  fog: true,
  bloom: !params.has("noeffects"),
  vignette: !params.has("noeffects"),
  sanitize: !params.has("nosanitize"),
  scan: null,
  toggle: (key, on) =>
    set((s) => {
      if ((LAYERS as readonly string[]).includes(key)) {
        const layer = key as LayerName;
        return { layers: { ...s.layers, [layer]: on ?? !s.layers[layer] } };
      }
      const flag = key as "fog" | "bloom" | "vignette" | "sanitize";
      return { [flag]: on ?? !s[flag] } as Partial<Diag>;
    }),
}));

const targets = new Map<string, WebGLRenderTarget>();

/**
 * Draws the scene as the composer does, into a buffer of half floats (or of
 * floats), before any effect, and counts the pixels no effect can take: NaN,
 * infinite, negative.
 */
export function scanScene(
  gl: WebGLRenderer,
  scene: Scene,
  camera: Camera,
  type: "half" | "float" = "half",
  scale = 1,
): Scan {
  const started = performance.now();
  const width = Math.max(1, Math.floor(gl.domElement.width * scale));
  const height = Math.max(1, Math.floor(gl.domElement.height * scale));
  const textureType: TextureDataType =
    type === "half" ? HalfFloatType : FloatType;
  const key = `${type}|${width}x${height}`;
  let target = targets.get(key);
  if (!target) {
    for (const t of targets.values()) t.dispose();
    targets.clear();
    target = new WebGLRenderTarget(width, height, {
      type: textureType,
      depthBuffer: true,
    });
    targets.set(key, target);
  }
  const previous = gl.getRenderTarget();
  const autoClear = gl.autoClear;
  gl.autoClear = true;
  gl.setRenderTarget(target);
  gl.render(scene, camera);
  const n = width * height * 4;
  const values = new Float32Array(n);
  if (type === "half") {
    const raw = new Uint16Array(n);
    gl.readRenderTargetPixels(target, 0, 0, width, height, raw);
    for (let i = 0; i < n; i++) values[i] = DataUtils.fromHalfFloat(raw[i]);
  } else {
    gl.readRenderTargetPixels(target, 0, 0, width, height, values);
  }
  gl.setRenderTarget(previous);
  gl.autoClear = autoClear;

  let nonFinite = 0;
  let negative = 0;
  let huge = 0;
  let min = Infinity;
  let max = -Infinity;
  let box: Scan["box"] = null;
  for (let p = 0; p < width * height; p++) {
    let bad = false;
    let neg = false;
    let big = false;
    for (let c = 0; c < 4; c++) {
      const v = values[p * 4 + c];
      if (!Number.isFinite(v)) bad = true;
      else if (c < 3) {
        if (v < 0) neg = true;
        if (v > 64) big = true;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (bad) {
      nonFinite++;
      const x = p % width;
      const y = Math.floor(p / width);
      box = box
        ? [
            Math.min(box[0], x),
            Math.min(box[1], y),
            Math.max(box[2], x),
            Math.max(box[3], y),
          ]
        : [x, y, x, y];
    } else if (neg) negative++;
    else if (big) huge++;
  }
  return {
    type,
    width,
    height,
    nonFinite,
    negative,
    huge,
    box,
    min,
    max,
    ms: Math.round(performance.now() - started),
  };
}

/** What the GPU is and supports, for the panel. */
export function gpuInfo(gl: WebGLRenderer): Record<string, string> {
  const ctx = gl.getContext();
  const info: Record<string, string> = {};
  const debug = ctx.getExtension("WEBGL_debug_renderer_info");
  info.renderer = debug
    ? String(ctx.getParameter(debug.UNMASKED_RENDERER_WEBGL))
    : String(ctx.getParameter(ctx.RENDERER));
  info.vendor = debug
    ? String(ctx.getParameter(debug.UNMASKED_VENDOR_WEBGL))
    : String(ctx.getParameter(ctx.VENDOR));
  info.webgl = String(ctx.getParameter(ctx.VERSION));
  info.glsl = String(ctx.getParameter(ctx.SHADING_LANGUAGE_VERSION));
  const has = (name: string) => (ctx.getExtension(name) ? "yes" : "no");
  info["color buffer float"] = has("EXT_color_buffer_float");
  info["color buffer half float"] = has("EXT_color_buffer_half_float");
  info["float blend"] = has("EXT_float_blend");
  info["float linear"] = has("OES_texture_float_linear");
  if ("MAX_SAMPLES" in ctx)
    info["max samples"] = String(
      ctx.getParameter((ctx as WebGL2RenderingContext).MAX_SAMPLES),
    );
  const precision = ctx.getShaderPrecisionFormat(
    ctx.FRAGMENT_SHADER,
    ctx.HIGH_FLOAT,
  );
  info["fragment highp"] = precision
    ? `2^${precision.rangeMax}, ${precision.precision} bits`
    : "none";
  info["max texture"] = String(ctx.getParameter(ctx.MAX_TEXTURE_SIZE));
  const points = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE) as
    Float32Array | undefined;
  if (points) info["point size"] = `${points[0]} to ${points[1]}`;
  return info;
}
