import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { clamp } from '../core/math.js';
import { GRADE, POST, SCALE } from '../art/direction.js';

/**
 * POST STACK — Fase 2.
 *
 * Five stages, in this order:
 *
 *   RenderPass  → scene into an HDR (half-float) target with a depth texture
 *   Bloom       → UnrealBloomPass, blended additively back into the same target
 *   Grade       → camera motion blur + ACES + saturation/contrast/vignette + sRGB
 *   SMAA        → antialiasing, on the finished LDR image
 *   Finish      → chromatic aberration + film grain, straight to the canvas
 *
 * Two structural decisions drive the whole file.
 *
 * TONE MAPPING MOVES HERE. three only applies `renderer.toneMapping` when it
 * draws to the canvas; anything rendered into a render target comes out
 * scene-linear. So the moment the composer exists the renderer's ACES step
 * silently stops happening, and it has to be done at the end of the chain
 * instead — which is also where it belongs, because bloom must see HDR values
 * and the grade must see display-referred ones. The curve below is three's own
 * ACES, and the exposure still comes from `renderer.toneMappingExposure`, so
 * main.js keeps ownership of `GRADE.exposure`. Applied exactly once.
 *
 * PASSES ARE MERGED WHEREVER THE COLOUR SPACE ALLOWS. Every pass here is
 * full-screen and the target is 60fps on an integrated GPU, so motion blur,
 * tone mapping and the whole grade share one fragment shader rather than four.
 * Only the two things that genuinely cannot be merged stay separate: SMAA (it
 * is three's own multi-pass shader) and grain/aberration (they must land after
 * antialiasing, or SMAA reads the grain as edges and smears it).
 */

/** Taps per pixel in the motion blur gather, on top of the centre sample. */
const MOTION_TAPS = 6;

/**
 * Blur length is expressed as a fraction of a 60 Hz frame rather than of the
 * actual frame, so the smear looks the same at 60 and at 144 Hz — same reason
 * the camera rig damps exponentially instead of lerping.
 */
const SHUTTER_HZ = 60;

/** A respawn teleports the camera; without a cap that frame smears end to end. */
const MAX_BLUR_UV = 0.045;

/**
 * The chase camera holds the player's aircraft at a fixed distance, so a
 * camera-derived velocity describes it as if it were scenery rushing past and
 * smears the one object that must stay readable. Fade the blur in past it.
 *
 * The band is deliberately narrow. Forward travel produces almost no screen
 * velocity near the centre of the frame; what actually reads as speed is the
 * ground sweeping through the bottom edge, which sits around five wingspans
 * out. A wider fade protects the plane but throws the effect away with it.
 */
const BLUR_FADE_NEAR = SCALE.planeWingspan * 3;
const BLUR_FADE_FAR = SCALE.planeWingspan * 5;

/** Grain resamples at a film-ish cadence: cheaper to look at than per-frame boil. */
const GRAIN_HZ = 24;

/** Frame times outside this band are hitches, not exposures. */
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 20;

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Motion blur, tone map and grade in one pass.
 *
 * The blur is camera-derived: depth is reprojected through last frame's
 * view-projection to get a per-pixel screen velocity. A real per-object
 * velocity buffer would mean a second geometry pass over streaming terrain to
 * fix the one case this misses — enemies moving against the flow, a few dozen
 * pixels each — and that trade is obviously bad here. Reprojection costs one
 * depth fetch and a matrix multiply, and unlike a flat directional smear it
 * gets the two things that are actually visible right: distance parallax, so
 * the far bank blurs less than the near one, and a still background.
 *
 * Reprojection runs in view space, not world space. The player's z grows
 * without bound — the world is infinite — and reconstructing world positions
 * from depth in a fragment shader at z = 50000 spends float precision on an
 * offset that cancels out anyway. Folding the camera transform into the matrix
 * on the CPU keeps the shader camera-relative.
 */
class GradePass extends Pass {
  constructor() {
    super();

    /** Set per frame by PostFX; zeroed here when there is no depth to read. */
    this.blur = 0;

    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uReproject: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      uBlur: { value: 0 },
      uExposure: { value: 1 },
      uSaturation: { value: GRADE.saturation },
      uContrast: { value: GRADE.contrast },
      uVignette: { value: GRADE.vignette },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'PostFX.grade',
      defines: {
        MOTION_TAPS: MOTION_TAPS,
        MAX_BLUR_UV: MAX_BLUR_UV.toFixed(6),
        BLUR_FADE_NEAR: BLUR_FADE_NEAR.toFixed(2),
        BLUR_FADE_FAR: BLUR_FADE_FAR.toFixed(2),
      },
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform mat4 uInvProj;
        uniform mat4 uReproject;
        uniform vec2 uTexel;
        uniform float uBlur;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
        uniform float uVignette;

        varying vec2 vUv;

        // three's ACESFilmicToneMapping, transcribed. Duplicated rather than
        // imported because this pass replaces the renderer's tone mapping
        // outright: if the two ever drift, the game changes look silently.
        vec3 RRTAndODTFit(vec3 v) {
          vec3 a = v * (v + 0.0245786) - 0.000090537;
          vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
          return a / b;
        }

        vec3 acesFilmic(vec3 color) {
          const mat3 ACESInputMat = mat3(
            vec3(0.59719, 0.07600, 0.02840),
            vec3(0.35458, 0.90834, 0.13383),
            vec3(0.04823, 0.01566, 0.83777)
          );
          const mat3 ACESOutputMat = mat3(
            vec3( 1.60475, -0.10208, -0.00327),
            vec3(-0.53108,  1.10813, -0.07276),
            vec3(-0.07367, -0.00605,  1.07602)
          );
          color *= uExposure / 0.6;
          color = ACESInputMat * color;
          color = RRTAndODTFit(color);
          color = ACESOutputMat * color;
          return clamp(color, 0.0, 1.0);
        }

        vec3 encodeSRGB(vec3 c) {
          c = max(c, vec3(0.0));
          return mix(c * 12.92, pow(c, vec3(0.41666)) * 1.055 - 0.055, step(vec3(0.0031308), c));
        }

        vec3 gatherMotion() {
          vec3 centre = texture2D(tDiffuse, vUv).rgb;
          if (uBlur <= 0.0) return centre;

          float depth = texture2D(tDepth, vUv).x;
          // Background: no surface to reproject, and smearing a smooth sky
          // gradient buys nothing anyway.
          if (depth >= 1.0) return centre;

          vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec4 viewPos = uInvProj * clip;
          viewPos /= viewPos.w;

          vec4 prevClip = uReproject * viewPos;
          vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

          vec2 vel = (vUv - prevUv) * uBlur;
          vel *= smoothstep(BLUR_FADE_NEAR, BLUR_FADE_FAR, -viewPos.z);

          float len = length(vel);
          if (len < uTexel.y) return centre;
          vel *= min(1.0, MAX_BLUR_UV / len);

          vec3 sum = centre;
          for (int i = 0; i < MOTION_TAPS; i++) {
            // Centred on the current frame rather than trailing behind it: a
            // one-sided smear reads as a ghost, a centred one reads as speed.
            float t = (float(i) + 0.5) / float(MOTION_TAPS) - 0.5;
            sum += texture2D(tDiffuse, vUv + vel * t).rgb;
          }
          return sum / float(MOTION_TAPS + 1);
        }

        void main() {
          vec3 color = acesFilmic(gatherMotion());

          // Grade in display-encoded space, not linear. "contrast 1.06" and a
          // 0.5 pivot only mean anything perceptually; the same curve applied
          // to linear light would crush the shadows the low sun depends on.
          color = encodeSRGB(color);

          float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(vec3(l), color, uSaturation);
          color = (color - 0.5) * uContrast + 0.5;

          float r = length(vUv - 0.5) * 1.41421356;
          color *= 1.0 - uVignette * smoothstep(0.32, 1.0, r);

          // Clamped because SMAA raises this to 2.2 downstream, and a negative
          // channel out of the contrast curve would come back NaN.
          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this._fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;

    // The scene target is still the read buffer at this point: RenderPass draws
    // into it and UnrealBloomPass blends back into it without swapping. Taking
    // the depth attachment from here rather than caching it means the pass
    // cannot desync from whichever of the composer's two buffers is current.
    const depth = readBuffer.depthTexture ?? null;
    this.uniforms.tDepth.value = depth;
    this.uniforms.uBlur.value = depth ? this.blur : 0;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._fsQuad.render(renderer);
  }

  setSize(width, height) {
    this.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}

/**
 * Chromatic aberration and grain, after antialiasing because both are noise by
 * design and SMAA would either eat them or mistake them for geometry.
 *
 * The grain seed is a pure function of the `time` argument — no `Math.random`,
 * same rule the sim and the screen shake follow. The screenshot harness diffs
 * pixels, so a frame that cannot be reproduced is a frame that cannot be
 * regression-tested.
 */
class FinishPass extends Pass {
  constructor() {
    super();

    this.uniforms = {
      tDiffuse: { value: null },
      uAberration: { value: POST.chromaticAberration },
      uGrain: { value: POST.grain },
      uSeed: { value: new THREE.Vector2() },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'PostFX.finish',
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uAberration;
        uniform float uGrain;
        uniform vec2 uSeed;

        varying vec2 vUv;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
        }

        void main() {
          // Radial, zero at the centre: a lens defect, not a global colour split.
          vec2 off = (vUv - 0.5) * uAberration;

          vec3 color = vec3(
            texture2D(tDiffuse, vUv + off).r,
            texture2D(tDiffuse, vUv).g,
            texture2D(tDiffuse, vUv - off).b
          );

          color += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;

          gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this._fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    // Half-float because everything up to the grade pass is HDR, and a depth
    // texture because the motion blur reprojects it. The depth texture replaces
    // the depth renderbuffer the target would have allocated anyway, so it is
    // effectively free.
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
      stencilBuffer: false,
    });
    target.texture.name = 'PostFX.scene';

    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      POST.bloomStrength,
      POST.bloomRadius,
      POST.bloomThreshold
    );
    this.composer.addPass(this.bloom);

    this.grade = new GradePass();
    this.composer.addPass(this.grade);

    // SMAA rather than TAA. three's TAARenderPass is jittered accumulation with
    // no reprojection — its own docs say so — which means it only converges on
    // a static frame. Here the terrain streams toward the camera at
    // SCALE.cruiseSpeed every second and nothing is ever static, so it would
    // ghost every pixel in the frame rather than a few. SMAA has no history
    // buffer at all, so it cannot ghost by construction, and against this art
    // direction — flat shading, hard silhouettes, no texture detail — its
    // pattern-based edge fitting is close to ideal.
    //
    // It sits *after* the grade because its blend shader raises the input to
    // 2.2 and its edge threshold is tuned for 0..1: fed pre-tone-map HDR it
    // both misfires and produces NaN. The renderer's MSAA is dead once the
    // composer exists — see the note in main.js integration.
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);

    this.finish = new FinishPass();
    this.composer.addPass(this.finish);

    this._pixelRatio = renderer.getPixelRatio();
    this._view = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._hasHistory = false;

    const canvas = renderer.getSize(new THREE.Vector2());
    this.setSize(canvas.x, canvas.y);
  }

  /**
   * Takes logical (CSS) pixels, exactly like `renderer.setSize`. Resizing the
   * renderer itself stays main.js's job; this only follows it.
   */
  setSize(width, height) {
    // Dragging a window between displays changes devicePixelRatio without any
    // other signal, and the composer caches the ratio it was built with.
    const ratio = this.renderer.getPixelRatio();
    if (ratio !== this._pixelRatio) {
      this._pixelRatio = ratio;
      this.composer.setPixelRatio(ratio);
    }

    this.composer.setSize(width, height);
  }

  /** Replaces renderer.render(scene, camera) in the frame loop. */
  render(dt, time) {
    const camera = this.camera;
    const step = clamp(dt, MIN_DT, MAX_DT);

    // The renderer normally does this inside render(); the reprojection matrix
    // has to be built before the composer runs, so do it here.
    camera.updateMatrixWorld();
    this._view.copy(camera.matrixWorld).invert();
    this._viewProj.multiplyMatrices(camera.projectionMatrix, this._view);

    const u = this.grade.uniforms;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uReproject.value.multiplyMatrices(this._prevViewProj, camera.matrixWorld);
    u.uExposure.value = this.renderer.toneMappingExposure;

    this.grade.blur = this._hasHistory
      ? POST.motionBlurStrength / (SHUTTER_HZ * step)
      : 0;

    // Bloom keys off post-exposure luminance so bloomThreshold reads as "how
    // bright on screen" — otherwise re-grading GRADE.exposure would silently
    // change what glows, which is exactly the coupling direction.js forbids.
    this.bloom.threshold = POST.bloomThreshold / Math.max(u.uExposure.value, 1e-3);

    const frame = Math.floor(time * GRAIN_HZ);
    this.finish.uniforms.uSeed.value.set(
      ((frame * 0.7548776662) % 1) * 1024,
      ((frame * 0.5698402909) % 1) * 1024
    );

    this.composer.render(step);

    this._prevViewProj.copy(this._viewProj);
    this._hasHistory = true;
  }

  dispose() {
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
  }
}
