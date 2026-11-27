/**
 * What keeps a bad pixel from blacking out the world.
 *
 * The bloom blurs through a chain of ever smaller textures: one NaN or
 * infinite pixel in the scene buffer becomes a texel of a small mip, and the
 * blur spreads it over a large, sharp-edged rectangle of the frame. What a
 * shader gives for a division by zero, a `pow` of a negative number or an
 * `atan(0, 0)`, and whether blending a huge alpha overflows half floats, varies
 * by GPU: a software renderer can give a finite value where a GPU gives NaN.
 * So every shader here avoids those operations, and `SanitizePass` replaces
 * whatever slips through before the bloom reads the buffer.
 */
import { Pass } from "postprocessing";
import {
  GLSL3,
  ShaderMaterial,
  Uniform,
  type Texture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";

/** The brightest value a pixel of the scene buffer may keep. */
export const MAX_RADIANCE = 32;

/**
 * Replaces each NaN or infinite channel of the scene buffer with 0, and
 * clamps the rest to [0, MAX_RADIANCE]. It tests the bits of each value, not
 * `isnan`, which a compiler may optimize away.
 */
export class SanitizePass extends Pass {
  constructor() {
    super("SanitizePass");
    this.fullscreenMaterial = new ShaderMaterial({
      name: "SanitizeMaterial",
      glslVersion: GLSL3,
      uniforms: { inputBuffer: new Uniform<Texture | null>(null) },
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D inputBuffer;
        in vec2 vUv;
        out vec4 color;
        float clean(float x, float hi) {
          bool finite = (floatBitsToUint(x) & 0x7f800000u) != 0x7f800000u;
          return finite ? clamp(x, 0.0, hi) : 0.0;
        }
        void main() {
          vec4 c = texture(inputBuffer, vUv);
          color = vec4(
            clean(c.r, ${MAX_RADIANCE.toFixed(1)}),
            clean(c.g, ${MAX_RADIANCE.toFixed(1)}),
            clean(c.b, ${MAX_RADIANCE.toFixed(1)}),
            clean(c.a, 1.0)
          );
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  override render(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    outputBuffer: WebGLRenderTarget,
  ) {
    const material = this.fullscreenMaterial as ShaderMaterial;
    material.uniforms.inputBuffer.value = inputBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }
}

/**
 * The fragment shader of drei's `Sparkles`, made finite: drei divides by the
 * distance to the center of the point, which is zero at the center pixel, and
 * its alpha goes negative at the corners of the point.
 */
export class SparklesMaterial extends ShaderMaterial {
  constructor() {
    super({
      uniforms: { time: { value: 0 }, pixelRatio: { value: 1 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float pixelRatio;
        uniform float time;
        attribute float size;
        attribute float speed;
        attribute float opacity;
        attribute vec3 noise;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vOpacity;
        void main() {
          vec4 modelPosition = modelMatrix * vec4(position, 1.0);
          modelPosition.y += sin(time * speed + modelPosition.x * noise.x * 100.0) * 0.2;
          modelPosition.z += cos(time * speed + modelPosition.x * noise.y * 100.0) * 0.2;
          modelPosition.x += cos(time * speed + modelPosition.x * noise.z * 100.0) * 0.2;
          vec4 viewPosition = viewMatrix * modelPosition;
          gl_Position = projectionMatrix * viewPosition;
          // In front of the camera only: a point at the camera has no size.
          gl_PointSize = size * 25.0 * pixelRatio / max(-viewPosition.z, 0.001);
          vColor = color;
          vOpacity = opacity;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vOpacity;
        void main() {
          float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
          // drei's glow, 0.05 / d - 0.1, kept within [0, 1].
          float strength = clamp(0.05 / max(distanceToCenter, 0.05) - 0.1, 0.0, 1.0);
          gl_FragColor = vec4(vColor, strength * vOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
  }
  get time(): number {
    return this.uniforms.time.value as number;
  }
  set time(value: number) {
    this.uniforms.time.value = value;
  }
  get pixelRatio(): number {
    return this.uniforms.pixelRatio.value as number;
  }
  set pixelRatio(value: number) {
    this.uniforms.pixelRatio.value = value;
  }
}
