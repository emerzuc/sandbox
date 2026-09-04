import * as THREE from 'three';
import { PALETTE, ATMOSPHERE, SCALE, BIOME_FOLLOW, biomeAt } from '../art/direction.js';
import {
  WATER_Y,
  RIVER_DEPTH,
  WORLD_HALF_W,
  WORLD_SEED,
  shoreSDF,
  terrainHeight,
  riverCenterX,
} from './river.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';
import { fbm2, hash2 } from '../core/rng.js';

/**
 * The river is the title character, so the water gets the one expensive trick in
 * the frame: a real planar reflection. Everything else here is analytic.
 *
 * Two facts about this world make that affordable. The surface is a known
 * horizontal plane at y = WATER_Y, so the reflection is an exact mirrored camera
 * into a half-res target rather than a screen-space guess. And the world is a
 * pure function of (x, z), so depth and distance-to-shore need no depth prepass
 * and no G-buffer — they are baked straight out of the same functions that built
 * the terrain mesh, into one scrolling field texture that follows the player.
 *
 * Cost: 1 draw for the surface, plus one half-res re-render of the scene.
 */

// --- field texture -----------------------------------------------------------
// One RGBA8 texture covering the visible window, addressed as a ring buffer in Z:
// texture row r holds every world row congruent to r (mod ROWS), so the shader's
// V coordinate is just z / SPAN_Z under repeat wrapping and nothing is ever
// reallocated — advancing the player rewrites rows, it does not rebuild the map.
const COLS = 256;
const ROWS = 320;
const DZ = 4;
const DX = (WORLD_HALF_W * 2) / COLS;
const SPAN_Z = ROWS * DZ;
const BEHIND = 200;

/** Signed distance is only interesting near the shore; ±28 keeps 0.22u of resolution. */
const SDF_RANGE = 28;

/** Lateral drift of the centreline, encoded into the field's alpha channel. */
const MEANDER_SCALE = 3;

const RIPPLE_SIZE = 256;
const REFLECT_SCALE = 0.5;

// The plane stops short of the ring's write head so no texel fetch ever
// straddles the seam between the newest row and the oldest one.
const PLANE_LEN = SPAN_Z - 4 * DZ;

// Ripple tiles, in world units. Sized off the river so the swell reads as water
// at this scale and not as a bathroom tile.
const RIPPLE_BIG = SCALE.riverWidthTypical * 0.95;
const RIPPLE_SMALL = SCALE.riverWidthTypical * 0.27;
const RIPPLE_TINY = SCALE.planeWingspan * 0.31;
const FOAM_NOISE = SCALE.riverWidthTypical * 0.6;
const FOAM_W = SCALE.riverWidthTypical * 0.085;

/**
 * Foam was authored against the placeholder grey key light and is now lit by a
 * 3.2-intensity sun with bloom downstream of it. At full strength the palette's
 * near-white foam became the brightest thing in the frame, cleared the 0.82
 * bloom threshold along the entire shoreline and read as a neon tube rather
 * than as water. Foam is lit spray, not an emitter: keep it under the bloom
 * knee and let the sun glitter be the only thing that blooms.
 */
const FOAM_GAIN = 0.72;

const REFLECT_FAR = 760;
const FLOW_SPEED = SCALE.cruiseSpeed * 0.09;
const REFL_DISTORT = 0.011;

/**
 * Seamless procedural normal + height tile. Periodic value noise: lattice
 * indices wrap at the octave's period, so the tile joins itself exactly and no
 * external image is needed to prove it.
 */
function periodicNoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(x - ix);
  const fy = smoothstep(y - iy);
  const w = (i, j) => hash2(((i % period) + period) % period, ((j % period) + period) % period, seed);
  const a = w(ix, iy);
  const b = w(ix + 1, iy);
  const c = w(ix, iy + 1);
  const d = w(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

function buildRippleTexture() {
  const n = RIPPLE_SIZE;
  const height = new Float32Array(n * n);
  // Deliberately non-harmonic periods: octaves that are exact multiples of each
  // other line their crests up and the tile becomes readable.
  const octaves = [[4, 0.5], [9, 0.27], [18, 0.15], [37, 0.08]];

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let h = 0;
      for (const [period, amp] of octaves) {
        h += periodicNoise(i / n, j / n, period, WORLD_SEED ^ (period * 7919)) * amp;
      }
      // Sharpen: value noise is too round to read as a water crest.
      height[j * n + i] = smoothstep(clamp01((h - 0.18) / 0.64));
    }
  }

  const data = new Uint8Array(n * n * 4);
  const BUMP = 7.5;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const l = height[j * n + ((i - 1 + n) % n)];
      const r = height[j * n + ((i + 1) % n)];
      const d = height[((j - 1 + n) % n) * n + i];
      const u = height[((j + 1) % n) * n + i];
      let nx = -(r - l) * BUMP;
      let ny = -(u - d) * BUMP;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const p = (j * n + i) * 4;
      data[p] = (nx * 0.5 + 0.5) * 255;
      data[p + 1] = (ny * 0.5 + 0.5) * 255;
      data[p + 2] = inv * 255;
      data[p + 3] = height[j * n + i] * 255;
    }
  }

  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// --- shaders -----------------------------------------------------------------

const VERT = /* glsl */ `
uniform mat4 uTextureMatrix;
varying vec3 vWorld;
varying vec4 vReflUv;
#include <fog_pars_vertex>

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vReflUv = uTextureMatrix * world;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = () => /* glsl */ `
#define HALF_W ${WORLD_HALF_W.toFixed(1)}
#define INV_SPAN_X ${(1 / (WORLD_HALF_W * 2)).toFixed(8)}
#define INV_SPAN_Z ${(1 / SPAN_Z).toFixed(8)}
#define SDF_RANGE ${SDF_RANGE.toFixed(1)}
#define RIPPLE_BIG ${RIPPLE_BIG.toFixed(3)}
#define RIPPLE_SMALL ${RIPPLE_SMALL.toFixed(3)}
#define RIPPLE_TINY ${RIPPLE_TINY.toFixed(3)}
#define FOAM_NOISE ${FOAM_NOISE.toFixed(3)}
#define FOAM_W ${FOAM_W.toFixed(3)}
#define FOAM_GAIN ${FOAM_GAIN.toFixed(3)}
#define FLOW_SPEED ${FLOW_SPEED.toFixed(3)}
#define REFL_DISTORT ${REFL_DISTORT.toFixed(4)}

uniform sampler2D tReflect;
uniform sampler2D tField;
uniform sampler2D tRipple;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uBed;
uniform vec3 uFoam;
uniform vec3 uSpec;
uniform vec3 uSunDir;
uniform float uSunPower;
uniform float uHaze;
uniform float uTime;

varying vec3 vWorld;
varying vec4 vReflUv;
#include <fog_pars_fragment>

vec4 tile(vec2 p, float scale, vec2 drift) {
  return texture2D(tRipple, (p + drift) / scale);
}

void main() {
  vec2 p = vWorld.xz;

  vec2 fieldUv = vec2((vWorld.x + HALF_W) * INV_SPAN_X, vWorld.z * INV_SPAN_Z);
  vec4 field = texture2D(tField, fieldUv);

  float sd = (field.g * 2.0 - 1.0) * SDF_RANGE;

  float depth01 = field.r;
  float breakup = field.b;
  float meander = field.a * 2.0 - 1.0;

  // Flow runs downstream, toward the player, and leans with the meander. It
  // slows in the shallows, so the margin does not sweep past at channel speed.
  vec2 flowDir = normalize(vec2(-meander, -1.0));
  float flowT = uTime * FLOW_SPEED * mix(0.45, 1.0, depth01);

  // Second layer is sampled in a rotated frame: two lattices at an irrational-ish
  // angle never re-align, so the surface neither tiles nor pulses.
  vec2 pr = vec2(p.x * 0.87 - p.y * 0.49, p.x * 0.49 + p.y * 0.87);
  vec2 fr = vec2(flowDir.x * 0.87 - flowDir.y * 0.49, flowDir.x * 0.49 + flowDir.y * 0.87);

  vec4 rBig = tile(vec2(p.x * 1.3, p.y), RIPPLE_BIG, flowDir * (flowT * 0.55));
  vec4 rSmall = tile(pr, RIPPLE_SMALL, fr * flowT);

  float dist = length(cameraPosition - vWorld);
  // Fine detail has to die off with distance or the whole river boils.
  float fine = 1.0 - smoothstep(90.0, 460.0, dist);
  // The margin sits in the lee of the bank, so damp the chop there — a little.
  float calm = mix(0.72, 1.0, depth01);

  vec2 nxz = (rBig.xy * 2.0 - 1.0) * (0.38 * calm)
           + (rSmall.xy * 2.0 - 1.0) * (0.22 * calm * fine);
  vec3 N = normalize(vec3(nxz.x, 1.0, nxz.y));

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = clamp(0.02 + 0.98 * pow(1.0 - ndv, 5.0), 0.0, 0.93);

  vec2 ruv = vReflUv.xy / max(vReflUv.w, 0.0001);
  ruv += nxz * (REFL_DISTORT * fine);
  vec3 refl = texture2D(tReflect, clamp(ruv, 0.001, 0.999)).rgb;

  #ifdef USE_FOG
  // The reflected ray crosses the same air the fog models, and at grazing angles
  // it crosses a lot of it. Haze the reflection before it is mixed in, or the
  // far water stays contrastier than the landscape it is reflecting.
  refl = mix(refl, fogColor, uHaze * (1.0 - ndv));
  #endif

  // Only the last hand's-breadth of water lets the bed's colour through; past
  // that it is absorption all the way down, and the channel reads as deep.
  vec3 shallow = mix(uShallow, uBed, 0.4 * (1.0 - smoothstep(0.0, 0.3, depth01)));
  vec3 body = mix(shallow, uDeep, smoothstep(0.05, 0.75, depth01));
  vec3 color = mix(body, refl, fres);

  // Glitter: a third, much finer tile perturbs the microfacet normal enough to
  // shatter the specular lobe into sparks instead of one smear, gated by the
  // swell's own height so they cluster on crests rather than cover the river.
  vec3 nT = tile(pr, RIPPLE_TINY, fr * (flowT * 1.7)).xyz * 2.0 - 1.0;
  vec3 G = normalize(vec3(nxz.x + nT.x * 0.4 * fine, 1.0, nxz.y + nT.y * 0.4 * fine));
  vec3 H = normalize(normalize(uSunDir) + V);
  float glint = pow(max(dot(G, H), 0.0), 900.0) * smoothstep(0.45, 0.9, rBig.a);

  // --- foam ---------------------------------------------------------------
  float toShore = -sd;
  // The waterline breathes. Phase runs along the bank and is offset by the baked
  // breakup noise, so the whole shore never laps in unison.
  float surge = sin(vWorld.z * 0.075 + vWorld.x * 0.021 + uTime * 1.25 + breakup * 6.2831);
  float band = FOAM_W * (0.6 + 0.4 * surge);
  float t = 1.0 - clamp(toShore / max(band, 0.4), 0.0, 1.0);

  float m1 = tile(p, FOAM_NOISE, flowDir * (flowT * 0.35)).a;
  float m2 = tile(pr, FOAM_NOISE * 0.34, fr * (flowT * 0.9)).a;
  float mask = m1 * 0.55 + m2 * 0.45;

  // Broken by the same noise as the wash. An unbroken lip saturates to a solid
  // band the full length of both banks — an outline drawn around the river.
  float lip = smoothstep(1.6, 0.0, toShore) * (0.3 + 0.7 * mask);
  float wash = smoothstep(0.55, 0.99, t * (0.4 + 0.85 * mask));
  // Torn-off foam drifting back out into the channel; without it the band reads
  // as an outline drawn around the river rather than as something the water did.
  float trail = smoothstep(FOAM_W * 1.8, FOAM_W * 0.5, toShore)
              * smoothstep(0.76, 0.97, mask) * 0.3;
  float foam = clamp(max(lip, wash) + trail, 0.0, 0.8);

  color = mix(color, uFoam * FOAM_GAIN, foam);
  color += uSpec * (glint * uSunPower * (1.0 - foam));

  // The bank is exactly coplanar with the surface at sd = 0, so the quad is let
  // a little way inland (polygon offset keeps it in front) and the foam is what
  // covers the join — otherwise the shoreline is a z-fighting seam.
  //
  // The discard is deliberately the LAST thing in the shader. Texture LOD comes
  // from implicit derivatives across a 2x2 quad; discarding a fragment before
  // its neighbours have sampled leaves their derivatives undefined, and on some
  // implementations the sample comes back NaN. One NaN texel at the river's
  // vanishing point, five bloom mips later, is a black frame. Intermittent —
  // it needs the shoreline to cross a quad at the horizon just so.
  if (sd > 1.5) discard;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Water {
  /** @param scene {THREE.Scene} @param renderer {THREE.WebGLRenderer} */
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.field = new THREE.DataTexture(
      new Uint8Array(COLS * ROWS * 4), COLS, ROWS, THREE.RGBAFormat
    );
    this.field.wrapS = THREE.ClampToEdgeWrapping;
    this.field.wrapT = THREE.RepeatWrapping;
    this.field.minFilter = THREE.LinearFilter;
    this.field.magFilter = THREE.LinearFilter;
    this.field.generateMipmaps = false;
    this.field.needsUpdate = true;

    this.ripple = buildRippleTexture();
    this.ripple.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

    // Window of world rows currently resident in the ring buffer, [lo, hi).
    this._lo = 0;
    this._hi = 0;
    // Player z at the last update, for the biome follow's respawn detection.
    this._lastZ = NaN;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      generateMipmaps: false,
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: frag(),
      fog: true,
      uniforms: {
        // Declared, not merged: UniformsUtils.merge clones values, and cloning a
        // render target texture silently drops it.
        fogColor: { value: new THREE.Color() },
        fogDensity: { value: 0.00025 },
        fogNear: { value: 1 },
        fogFar: { value: 2000 },

        tReflect: { value: this.target.texture },
        tField: { value: this.field },
        tRipple: { value: this.ripple },
        uTextureMatrix: { value: new THREE.Matrix4() },
        uDeep: { value: new THREE.Color(PALETTE.waterDeep) },
        uShallow: { value: new THREE.Color(PALETTE.waterShallow) },
        uBed: { value: new THREE.Color(PALETTE.sand) },
        uFoam: { value: new THREE.Color(PALETTE.waterFoam) },
        uSpec: { value: new THREE.Color(PALETTE.waterSpecular) },
        uSunDir: { value: new THREE.Vector3(...PALETTE.sunDirection) },
        uSunPower: { value: PALETTE.sunIntensity },
        uHaze: { value: ATMOSPHERE.hazeStrength },
        uTime: { value: 0 },
      },
      // The water and the bank meet exactly at y = WATER_Y. Bias the surface
      // toward the camera so that band resolves consistently instead of
      // shimmering, and let the foam hide the overlap.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_HALF_W * 2, PLANE_LEN, 8, 96),
      this.material
    );
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = WATER_Y;
    scene.add(this.mesh);

    this._reflectCam = new THREE.PerspectiveCamera();
    this._normal = new THREE.Vector3(0, 1, 0);
    this._origin = new THREE.Vector3(0, WATER_Y, 0);
    this._view = new THREE.Vector3();
    this._target3 = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._rot = new THREE.Matrix4();
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();

    const size = renderer.getSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
  }

  /** Rewrite the ring rows the player has advanced into. Nothing is reallocated. */
  _syncField(playerZ) {
    const lo = Math.floor((playerZ - BEHIND) / DZ);
    const hi = lo + ROWS;
    if (lo === this._lo && hi === this._hi) return;

    if (lo >= this._hi || hi <= this._lo) {
      // Respawn teleported us clean out of the window; nothing is reusable.
      for (let r = lo; r < hi; r++) this._bakeRow(r);
    } else {
      for (let r = this._hi; r < hi; r++) this._bakeRow(r);
      for (let r = lo; r < this._lo; r++) this._bakeRow(r);
    }

    this._lo = lo;
    this._hi = hi;
    this.field.needsUpdate = true;
  }

  _bakeRow(worldRow) {
    const z = (worldRow + 0.5) * DZ;
    const row = ((worldRow % ROWS) + ROWS) % ROWS;
    const data = this.field.image.data;
    let p = row * COLS * 4;

    // Constant along the row: the direction the current leans at this z.
    const slope = clamp((riverCenterX(z + DZ) - riverCenterX(z - DZ)) / (2 * DZ) * MEANDER_SCALE, -1, 1);
    const a = (slope * 0.5 + 0.5) * 255;

    for (let c = 0; c < COLS; c++) {
      const x = -WORLD_HALF_W + (c + 0.5) * DX;
      const sd = shoreSDF(x, z);
      // Depth comes from the same function the mesh was built from, so the tint
      // can never disagree with the riverbed the player is actually flying over.
      const depth = sd < 0 ? WATER_Y - terrainHeight(x, z) : 0;

      data[p++] = clamp01(depth / RIVER_DEPTH) * 255;
      data[p++] = (clamp(sd / SDF_RANGE, -1, 1) * 0.5 + 0.5) * 255;
      data[p++] = fbm2(x * 0.055, z * 0.055, WORLD_SEED ^ 0x5ea, 2) * 255;
      data[p++] = a;
    }
  }

  _renderReflection(camera) {
    const renderer = this.renderer;
    const cam = this._reflectCam;

    camera.updateMatrixWorld();
    this._camPos.setFromMatrixPosition(camera.matrixWorld);

    // Below the surface there is nothing to mirror; keep the last frame.
    this._view.subVectors(this._origin, this._camPos);
    if (this._view.dot(this._normal) > 0) return;

    this._view.reflect(this._normal).negate().add(this._origin);

    this._rot.extractRotation(camera.matrixWorld);
    this._look.set(0, 0, -1).applyMatrix4(this._rot).add(this._camPos);
    this._target3.subVectors(this._origin, this._look).reflect(this._normal).negate().add(this._origin);

    cam.position.copy(this._view);
    cam.up.set(0, 1, 0).applyMatrix4(this._rot).reflect(this._normal);
    cam.lookAt(this._target3);
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.near = camera.near;
    // The reflection stops well short of the main camera's far plane. Past
    // ~700 units the mirrored landscape is already most of the way to fog, and
    // the shader hazes the reflection further at the grazing angles where the
    // far water is seen — so those chunks cost a full re-render and change
    // nothing on screen. Frustum culling drops them for free.
    cam.far = REFLECT_FAR;
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();

    // Projective lookup: the shader multiplies the world position by this, so no
    // model matrix is folded in and the plane is free to slide with the player.
    const m = this.material.uniforms.uTextureMatrix.value;
    m.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    m.multiply(cam.projectionMatrix);
    m.multiply(cam.matrixWorldInverse);

    // Oblique near plane: without it the riverbed sits *above* the mirrored
    // camera and gets reflected too, smearing a dark band over the far bank.
    this._plane.setFromNormalAndCoplanarPoint(this._normal, this._origin);
    this._plane.applyMatrix4(cam.matrixWorldInverse);
    this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);

    const e = cam.projectionMatrix.elements;
    this._q.set(
      (Math.sign(this._clip.x) + e[8]) / e[0],
      (Math.sign(this._clip.y) + e[9]) / e[5],
      -1,
      (1 + e[10]) / e[14]
    );
    this._clip.multiplyScalar(2 / this._clip.dot(this._q));
    e[2] = this._clip.x;
    e[6] = this._clip.y;
    e[10] = this._clip.z + 1 - 0.003;
    e[14] = this._clip.w;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadow = renderer.shadowMap.autoUpdate;

    this.mesh.visible = false;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(this.scene, cam);

    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
    this.mesh.visible = true;
  }

  /**
   * The water's colours follow biomeAt(playerZ) with the same easing and the
   * same respawn snap as the light rig, so the body of the river and the air
   * over it are always in the same biome at the same moment. The fog uniforms
   * are three's own (`fog: true`) and follow scene.fog, which the rig damps.
   * Inside a pure biome every target equals the current value and the lerps
   * are exact no-ops.
   */
  _followBiome(dt, playerZ) {
    const b = biomeAt(playerZ);
    const u = this.material.uniforms;
    const snap = !(Math.abs(playerZ - this._lastZ) <= BIOME_FOLLOW.teleport);
    this._lastZ = playerZ;

    if (snap) {
      u.uDeep.value.copy(b.waterDeep);
      u.uShallow.value.copy(b.waterShallow);
      u.uBed.value.copy(b.sand);
      u.uFoam.value.copy(b.waterFoam);
      u.uSpec.value.copy(b.waterSpecular);
      u.uSunPower.value = b.sunIntensity;
      u.uHaze.value = b.hazeStrength;
      return;
    }
    const k = 1 - Math.exp(-BIOME_FOLLOW.rate * dt);
    u.uDeep.value.lerp(b.waterDeep, k);
    u.uShallow.value.lerp(b.waterShallow, k);
    u.uBed.value.lerp(b.sand, k);
    u.uFoam.value.lerp(b.waterFoam, k);
    u.uSpec.value.lerp(b.waterSpecular, k);
    u.uSunPower.value = lerp(u.uSunPower.value, b.sunIntensity, k);
    u.uHaze.value = lerp(u.uHaze.value, b.hazeStrength, k);
  }

  /** Called once per frame, before renderer.render. */
  update(dt, time, playerZ, camera) {
    this._followBiome(dt, playerZ);
    this._syncField(playerZ);
    this.mesh.position.z = playerZ - BEHIND + 2 * DZ + PLANE_LEN / 2;
    this.material.uniforms.uTime.value = time;
    this._renderReflection(camera);
  }

  setSize(width, height) {
    const pr = this.renderer.getPixelRatio();
    this.target.setSize(
      Math.max(1, Math.floor(width * pr * REFLECT_SCALE)),
      Math.max(1, Math.floor(height * pr * REFLECT_SCALE))
    );
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.field.dispose();
    this.ripple.dispose();
    this.target.dispose();
  }
}
