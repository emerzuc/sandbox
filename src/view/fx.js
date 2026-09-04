import * as THREE from 'three';
import { PALETTE, SCALE } from '../art/direction.js';
import { hash1, fbm2 } from '../core/rng.js';

/**
 * VFX. Destruction feedback is most of what makes a shooter feel good, so this
 * module gets a disproportionate share of the frame budget — but it gets it in
 * *fill rate*, not in draw calls or in garbage.
 *
 * Three ideas hold the whole thing up:
 *
 * 1. **The whole module is three draw calls.** Two instanced billboard fields
 *    (one additive for anything hot, one alpha-blended for smoke) and one
 *    InstancedMesh of physical chunks. Adding a hundred particles costs a
 *    handful of float writes, never a draw call and never a scene-graph node.
 *
 * 2. **A particle is a closed-form function of its age, evaluated on the GPU.**
 *    Spawning writes ~19 floats into a ring buffer; after that the CPU does
 *    nothing but bump one uniform. Nothing integrates, so nothing drifts: the
 *    same effect at the same age looks identical at 30 fps and at 144, which is
 *    what the screenshot harness needs and what per-frame Euler integration
 *    could never give.
 *
 * 3. **No randomness, ever.** Every scrap of variation comes from `hash1` over
 *    a spawn counter. Same call sequence ⇒ same pixels.
 *
 * ---------------------------------------------------------------- hitstop ---
 * `update(dt, time)` must be fed the *simulation* clock (`game.time`), not wall
 * time. That makes effects freeze with the sim during hitstop, which is the
 * deliberate choice: hitstop is 55–160 ms and the core flash only lives 130 ms,
 * so animating through the freeze would burn the entire flash while the world
 * is stopped and the kill would resolve into smoke the instant motion resumed.
 * Frozen, the bright frame is *held* — that hold is the punch. It also keeps
 * the effects deterministic, since the sim clock advances in fixed steps.
 */

const TAU = Math.PI * 2;

// Matches the sim's own debris fall so the two read as one world, and a floor
// at the waterline so a chunk lands on the river instead of sinking through it.
const GRAVITY = 62;
const CHUNK_FLOOR = 0.35;

// Palette-derived colours, resolved once. Nothing below may invent a hue.
const C = {
  core: new THREE.Color(PALETTE.explosionCore),
  mid: new THREE.Color(PALETTE.explosionMid),
  smoke: new THREE.Color(PALETTE.explosionSmoke),
  muzzle: new THREE.Color(PALETTE.muzzle),
  tracer: new THREE.Color(PALETTE.tracer),
  chunk: new THREE.Color(PALETTE.hostileBody),
};
const mix = (a, b, t) => new THREE.Color().lerpColors(a, b, t);

// The fireball's roll from core through mid toward smoke, pre-mixed so no
// colour work happens per spawn. Additive blending does the cooling for free:
// as the end colour approaches explosionSmoke its contribution approaches zero.
// Mixing happens in linear space, where explosionMid is roughly thirteen times
// the luminance of explosionSmoke — so an even blend is still almost pure fire.
// The weights below are what actually land where they read.
const FIRE_A = [C.mid, mix(C.core, C.mid, 0.6), C.mid];
const FIRE_B = [mix(C.mid, C.smoke, 0.8), mix(C.mid, C.smoke, 0.95), C.smoke];
const SMOKE_A = mix(C.mid, C.smoke, 0.92);
const SMOKE_B = C.smoke;
const EMBER_B = mix(C.mid, C.smoke, 0.6);
const CHUNK_HOT = mix(C.mid, C.chunk, 0.45);
const CHUNK_COLD = mix(C.chunk, C.smoke, 0.3);

/**
 * Explosions are lifted off their origin by this much per unit of scale. A
 * fireball centred exactly on a ship sitting on the water has half its volume
 * under the water plane, and with no depth texture to fade against, the depth
 * test slices it along a dead-straight line. Lifting it puts the cut down in
 * the dim lower fringe, where it reads as the blast sitting *on* the river
 * instead of as a rectangle cut out of it.
 */
const LIFT = 2.5;

// Tiles in the procedural atlas.
const TILE_PUFF = 0;
const TILE_FLARE = 1;

// Pool sizes. A bridge (scale 2.5) costs ~40 hot + ~18 smoke + ~15 chunks, so
// this holds four simultaneous large kills before the ring starts eating its
// own tail — and eating the oldest particle is the correct failure mode anyway.
const HOT_CAP = 640;
const SMOKE_CAP = 256;
const CHUNK_CAP = 128;

// ---------------------------------------------------------------- textures

const ATLAS_TILE = 128;
const ATLAS_TILES = 2;

/**
 * Sprite atlas, built arithmetically rather than with a canvas. Canvas gradient
 * rasterisation is not bit-identical across platforms and skia versions; the
 * harness diffs pixels, so the texture has to come from our own maths.
 *
 * RGB is left pure white and all shape lives in alpha, which keeps the texture
 * colour-space agnostic — the tint comes entirely from the palette.
 */
function buildAtlas() {
  const T = ATLAS_TILE;
  const W = T * ATLAS_TILES;
  const data = new Uint8Array(W * T * 4);
  const half = T * 0.5;

  for (let y = 0; y < T; y++) {
    for (let tile = 0; tile < ATLAS_TILES; tile++) {
      for (let x = 0; x < T; x++) {
        const dx = (x + 0.5 - half) / half;
        const dy = (y + 0.5 - half) / half;
        const r = Math.sqrt(dx * dx + dy * dy);
        let a = 0;

        if (tile === TILE_PUFF) {
          // Not a gaussian ball: the radius itself is warped by noise so the
          // silhouette is lumpy, and the interior gets a second, finer octave.
          // A fireball is legible because you can count its puffs — blur that
          // and forty additive sprites integrate into one orange light bulb.
          const warped = r * (0.74 + 0.5 * fbm2(x * 0.042, y * 0.042, 917, 4));
          const e = Math.max(0, Math.min(1, (0.95 - warped) / 0.42));
          a = e * e * (3 - 2 * e) * (0.5 + 0.7 * fbm2(x * 0.11, y * 0.11, 31, 3));
        } else {
          // Hot flare: tight core, wide halo, and a four-point star so a muzzle
          // flash still reads as a flash at two or three pixels across.
          const fall = Math.max(0, 1 - r / 0.96);
          const core = Math.pow(fall, 9);
          const halo = Math.pow(fall, 3.4) * 0.42;
          const ax = Math.abs(dx) / 0.96;
          const ay = Math.abs(dy) / 0.96;
          const spike =
            Math.pow(Math.max(0, 1 - ax), 3) * Math.pow(Math.max(0, 1 - ay * 8), 3) +
            Math.pow(Math.max(0, 1 - ay), 3) * Math.pow(Math.max(0, 1 - ax * 8), 3);
          a = core + halo + spike * 0.5;
        }

        // Belt and braces at the rim: the two tiles share a mip chain, and any
        // alpha left at the border bleeds one silhouette into the other.
        if (r > 0.94) a = 0;

        const i = (y * W + tile * T + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
      }
    }
  }

  const tex = new THREE.DataTexture(data, W, T, THREE.RGBAFormat);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ shaders

const SPRITE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uTileScale;

  attribute vec3 aOrigin;
  attribute vec3 aVel;
  attribute vec2 aLife;   // birth time, 1 / lifetime
  attribute vec2 aSize;   // diameter at birth, at death
  attribute vec4 aDyn;    // drag, gravity, roll phase, roll rate
  attribute vec3 aColA;
  attribute vec3 aColB;
  attribute vec3 aOpt;    // opacity, turbulence, atlas tile

  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFogDepth;

  void main() {
    float t = uTime - aLife.x;
    float age = t * aLife.y;

    // Dead or not yet born: collapse off-screen. Cheaper than any CPU-side
    // compaction and it keeps the ring buffer free of holes.
    if (age < 0.0 || age >= 1.0) {
      vUv = vec2(0.0);
      vColor = vec4(0.0);
      vFogDepth = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Ballistics in closed form. Exponential drag integrates analytically, so
    // position depends only on age — never on how the frames happened to land.
    float k = aDyn.x;
    vec3 disp = aVel * (k > 1e-4 ? (1.0 - exp(-k * t)) / k : t);
    disp.y += 0.5 * aDyn.y * t * t;

    float ph = aDyn.z;
    disp += aOpt.y * age * vec3(
      sin(t * 1.7 + ph), cos(t * 1.1 + ph * 1.7), sin(t * 1.3 + ph * 2.3));

    vec4 mv = modelViewMatrix * vec4(aOrigin + disp, 1.0);

    // Fast out, slow in: the first frames of a blast are the ones that sell it.
    float ease = 1.0 - pow(1.0 - age, 3.0);
    float size = mix(aSize.x, aSize.y, ease);

    float rot = ph + aDyn.w * t;
    vec2 cs = vec2(cos(rot), sin(rot));
    vec2 q = position.xy * size;
    mv.xy += vec2(q.x * cs.x - q.y * cs.y, q.x * cs.y + q.y * cs.x);

    #ifdef FX_SMOKE
      // Smoke has to bloom in, or the puff pops into existence mid-air.
      float a = smoothstep(0.0, 0.22, age) * (1.0 - smoothstep(0.3, 1.0, age));
    #else
      float a = (1.0 - age) * (1.0 - age);
    #endif

    vColor = vec4(mix(aColA, aColB, sqrt(age)), a * aOpt.x);
    vUv = vec2((uv.x + aOpt.z) * uTileScale, uv.y);
    vFogDepth = -mv.z;

    // A camera-facing quad centred on a particle resting on the water has half
    // its area behind the water, and the depth test slices it along a hard
    // line. There is no depth texture here to do a proper soft-particle fade
    // with, so the quad keeps its true screen position and size and only its
    // *depth* is biased toward the camera — enough for a puff to clear the
    // surface it is resting on, without the parallax and scale error that
    // actually moving the billboard would introduce.
    float push = min(size * 0.75, -mv.z * 0.35);
    vec4 clip = projectionMatrix * mv;
    vec4 biased = projectionMatrix * vec4(mv.xy, mv.z + push, 1.0);
    gl_Position = vec4(clip.xy * (biased.w / clip.w), biased.z, biased.w);
  }
`;

const SPRITE_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uFogColor;
  uniform vec2 uFogRange;

  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFogDepth;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    gl_FragColor = vec4(vColor.rgb, vColor.a * tex.a);
    if (gl_FragColor.a < 0.004) discard;

    float fog = smoothstep(uFogRange.x, uFogRange.y, vFogDepth);
    #ifdef FX_SMOKE
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, fog);
    #else
      // Additive light cannot be *mixed* toward the fog colour without haze
      // making distant explosions brighter. Distance must only ever dim it.
      gl_FragColor.rgb *= 1.0 - fog;
    #endif

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------- spawn params

/**
 * One reusable descriptor, mutated and handed to `emit`. An options object per
 * particle would be the readable way to do this and would also allocate forty
 * short-lived objects every time something explodes.
 */
class Spawn {
  constructor() {
    this.ca = C.core;
    this.cb = C.mid;
    this.reset();
  }

  reset() {
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.delay = 0;
    this.life = 1;
    this.size0 = 1;
    this.size1 = 1;
    this.drag = 0;
    this.grav = 0;
    this.phase = 0;
    this.roll = 0;
    this.turb = 0;
    this.opacity = 1;
    this.tile = TILE_PUFF;
    this.ca = C.core;
    this.cb = C.mid;
    return this;
  }
}

// ------------------------------------------------------------ sprite fields

class SpriteField {
  constructor(scene, texture, capacity, smoke) {
    this.capacity = capacity;
    this.head = 0;
    this.until = -1;
    this.dirty = false;

    this.origin = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.lifeA = new Float32Array(capacity * 2);
    this.sizeA = new Float32Array(capacity * 2);
    this.dyn = new Float32Array(capacity * 4);
    this.colA = new Float32Array(capacity * 3);
    this.colB = new Float32Array(capacity * 3);
    this.opt = new Float32Array(capacity * 3);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.instanceCount = capacity;

    this.attrs = [];
    const attr = (name, arr, size) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      this.attrs.push(a);
    };
    attr('aOrigin', this.origin, 3);
    attr('aVel', this.vel, 3);
    attr('aLife', this.lifeA, 2);
    attr('aSize', this.sizeA, 2);
    attr('aDyn', this.dyn, 4);
    attr('aColA', this.colA, 3);
    attr('aColB', this.colB, 3);
    attr('aOpt', this.opt, 3);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: texture },
        uTileScale: { value: 1 / ATLAS_TILES },
        uFogColor: { value: new THREE.Color(0, 0, 0) },
        uFogRange: { value: new THREE.Vector2(1e6, 2e6) },
      },
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      defines: smoke ? { FX_SMOKE: '' } : {},
      transparent: true,
      // Depth-tested so particles sit behind terrain, but never depth-writing:
      // a billboard that writes depth punches a rectangular hole through the
      // water and through every particle drawn after it.
      depthTest: true,
      depthWrite: false,
      blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
    });

    this.geometry = g;
    this.material = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;   // instances live far outside the base quad
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = smoke ? 10 : 11;   // hot layer over its own smoke
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  emit(s, clock) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const i2 = i * 2, i3 = i * 3, i4 = i * 4;

    this.origin[i3] = s.x; this.origin[i3 + 1] = s.y; this.origin[i3 + 2] = s.z;
    this.vel[i3] = s.vx; this.vel[i3 + 1] = s.vy; this.vel[i3 + 2] = s.vz;
    this.lifeA[i2] = clock + s.delay;
    this.lifeA[i2 + 1] = 1 / s.life;
    this.sizeA[i2] = s.size0;
    this.sizeA[i2 + 1] = s.size1;
    this.dyn[i4] = s.drag;
    this.dyn[i4 + 1] = s.grav;
    this.dyn[i4 + 2] = s.phase;
    this.dyn[i4 + 3] = s.roll;
    this.colA[i3] = s.ca.r; this.colA[i3 + 1] = s.ca.g; this.colA[i3 + 2] = s.ca.b;
    this.colB[i3] = s.cb.r; this.colB[i3 + 1] = s.cb.g; this.colB[i3 + 2] = s.cb.b;
    this.opt[i3] = s.opacity; this.opt[i3 + 1] = s.turb; this.opt[i3 + 2] = s.tile;

    this.dirty = true;
    const end = clock + s.delay + s.life;
    if (end > this.until) this.until = end;
  }

  update(clock, fogColor, fogNear, fogFar) {
    // One uniform is the entire per-frame cost of an arbitrary particle count.
    this.material.uniforms.uTime.value = clock;
    this.material.uniforms.uFogColor.value.copy(fogColor);
    this.material.uniforms.uFogRange.value.set(fogNear, fogFar);

    if (this.dirty) {
      // Re-uploading the whole ring on a spawn frame is a ~50 KB memcpy and
      // costs less than tracking dirty ranges across wraparound.
      // Indexed, not for-of: an iterator object per frame is still garbage.
      for (let i = 0; i < this.attrs.length; i++) this.attrs[i].needsUpdate = true;
      this.dirty = false;
    }
    this.mesh.visible = clock < this.until;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------- chunks

/** Irregular lump, flat shaded. Pure billboards read as flat; this is the fix. */
function chunkGeometry() {
  const g = new THREE.IcosahedronGeometry(0.5, 0).toNonIndexed();
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Keyed on the vertex position, not the vertex index, so the copies of a
    // shared corner in different triangles all move together and the hull
    // stays closed instead of splitting into unconnected shards.
    const s = 0.6 + hash1(Math.round((x * 13.7 + y * 29.3 + z * 57.1) * 64), 0x51ed) * 0.85;
    p.setXYZ(i, x * s, y * s * 0.85, z * s);
  }
  g.computeVertexNormals();
  return g;
}

class ChunkField {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.head = 0;
    this.until = -1;

    this.origin = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.axis = new Float32Array(capacity * 3);
    this.meta = new Float32Array(capacity * 4);   // birth, 1/life, size, spin rate

    this.geometry = chunkGeometry();
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,   // white base: the per-instance colour carries the tint
      roughness: 0.82,
      metalness: 0.03,
      flatShading: true,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._a = new THREE.Vector3(0, 1, 0);
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();

    // Allocates instanceColor once, and parks everything at zero scale.
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this._m);
      this.mesh.setColorAt(i, C.chunk);
    }
    scene.add(this.mesh);
  }

  emit(x, y, z, vx, vy, vz, life, size, ax, ay, az, spin, clock) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const i3 = i * 3, i4 = i * 4;
    this.origin[i3] = x; this.origin[i3 + 1] = y; this.origin[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.axis[i3] = ax; this.axis[i3 + 1] = ay; this.axis[i3 + 2] = az;
    this.meta[i4] = clock;
    this.meta[i4 + 1] = 1 / life;
    this.meta[i4 + 2] = size;
    this.meta[i4 + 3] = spin;
    const end = clock + life;
    if (end > this.until) this.until = end;
  }

  update(clock) {
    if (clock >= this.until) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    for (let i = 0; i < this.capacity; i++) {
      const i3 = i * 3, i4 = i * 4;
      const t = clock - this.meta[i4];
      const age = t * this.meta[i4 + 1];

      if (age < 0 || age >= 1) {
        this._m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this._m);
        continue;
      }

      // Same closed form as the sprites: position depends only on age.
      const y = this.origin[i3 + 1] + this.vel[i3 + 1] * t - 0.5 * GRAVITY * t * t;
      this._p.set(
        this.origin[i3] + this.vel[i3] * t,
        y > CHUNK_FLOOR ? y : CHUNK_FLOOR,
        this.origin[i3 + 2] + this.vel[i3 + 2] * t
      );

      this._a.set(this.axis[i3], this.axis[i3 + 1], this.axis[i3 + 2]);
      this._q.setFromAxisAngle(this._a, t * this.meta[i4 + 3]);

      const shrink = 1 - Math.max(0, (age - 0.7) / 0.3) ** 2;
      const sc = this.meta[i4 + 2] * shrink;
      this._s.set(sc, sc, sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);

      // Chunks leave the blast glowing and char within half a second.
      // Diffuse only: a per-instance emissive would mean a bespoke shader for a
      // dozen lumps, and the embers already carry the actual light.
      this._c.copy(CHUNK_HOT).lerp(CHUNK_COLD, Math.min(1, age * 2.2));
      this.mesh.setColorAt(i, this._c);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ----------------------------------------------------------------------- FX

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.texture = buildAtlas();
    this.hot = new SpriteField(scene, this.texture, HOT_CAP, false);
    this.smoke = new SpriteField(scene, this.texture, SMOKE_CAP, true);
    this.chunks = new ChunkField(scene, CHUNK_CAP);

    this.clock = 0;
    this.prev = 0;
    this.seq = 0;
    this.s = new Spawn();

    this._fogColor = new THREE.Color(0, 0, 0);
    this._fogNear = 1e6;
    this._fogFar = 2e6;
  }

  /**
   * One kill. `scale` is a radius multiplier: ~1 for a ship or the player, ~2.5
   * for a bridge.
   *
   * Three beats, and the layering is the whole trick — a single expanding
   * sphere is what a placeholder looks like:
   *   1. a core flash, huge and gone in eight frames, that says *now*;
   *   2. a fireball of puffs rolling explosionMid → explosionSmoke as it stalls;
   *   3. smoke that outlives both by two seconds and drifts, plus embers and
   *      physical chunks so the silhouette is not all billboards.
   */
  explosion(position, scale = 1) {
    const sc = Math.max(0.35, scale);
    const t = this.clock;
    const s = this.s;
    let n = this.seq;

    // --- 1. core flash ---
    for (let i = 0; i < 2; i++) {
      s.reset();
      s.x = position.x + (hash1(n++, 3) - 0.5) * 2.4 * sc;
      s.y = position.y + LIFT * sc + (hash1(n++, 5) - 0.5) * 2.0 * sc;
      s.z = position.z + (hash1(n++, 7) - 0.5) * 2.4 * sc;
      s.life = 0.12 + i * 0.05;
      s.size0 = 6 * sc;
      s.size1 = (18 + i * 7) * sc;
      s.grav = 3;
      s.phase = hash1(n++, 11) * TAU;
      s.tile = i === 0 ? TILE_FLARE : TILE_PUFF;
      s.ca = C.core;
      s.cb = C.mid;
      this.hot.emit(s, t);
    }

    // --- 2. fireball ---
    const fire = Math.min(24, Math.round(8 * sc) + 5);
    for (let i = 0; i < fire; i++) {
      const u = hash1(n++, 13) * 2 - 1;
      const a = hash1(n++, 17) * TAU;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      const spd = (4 + hash1(n++, 19) * 7) * sc;
      const k = hash1(n++, 23);
      const dx = Math.cos(a) * r;
      const dy = u * 0.7 + 0.35;      // biased up: hot gas rises
      const dz = Math.sin(a) * r;
      const shell = (2 + k * 4) * sc;

      s.reset();
      // Born on a shell rather than all at the same point. Forty puffs from one
      // origin integrate into a smooth ball; from a shell they stay legible as
      // puffs, which is the difference between a fireball and a light bulb.
      s.x = position.x + dx * shell;
      s.y = position.y + LIFT * sc + dy * shell;
      s.z = position.z + dz * shell;
      s.vx = dx * spd; s.vy = dy * spd; s.vz = dz * spd;
      s.delay = k * 0.05;
      s.life = 0.5 + k * 0.45;
      s.size0 = 6 * sc;
      s.size1 = (12 + k * 7) * sc;
      s.drag = 2.6;
      s.grav = 5;
      s.phase = hash1(n++, 29) * TAU;
      s.roll = (k - 0.5) * 2.4;
      s.opacity = 0.3;
      s.ca = FIRE_A[i % FIRE_A.length];
      s.cb = FIRE_B[i % FIRE_B.length];
      this.hot.emit(s, t);
    }

    // --- embers: the arcing sparks that make the blast read as *debris* ---
    const embers = Math.min(16, Math.round(4 * sc) + 4);
    for (let i = 0; i < embers; i++) {
      const u = hash1(n++, 31) * 2 - 1;
      const a = hash1(n++, 37) * TAU;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      const g = 0.7 + sc * 0.3;
      const spd = (14 + hash1(n++, 41) * 20) * g;

      s.reset();
      s.x = position.x; s.y = position.y; s.z = position.z;
      s.vx = Math.cos(a) * r * spd;
      s.vy = (u * 0.5 + 0.55) * spd;
      s.vz = Math.sin(a) * r * spd;
      s.life = 0.4 + hash1(n++, 43) * 0.45;
      s.size0 = (0.7 + hash1(n++, 47) * 0.9) * g;
      s.size1 = 0.2 * g;
      s.drag = 1.5;
      s.grav = -GRAVITY * 0.55;
      s.opacity = 0.9;
      s.tile = TILE_FLARE;
      s.ca = C.core;
      s.cb = EMBER_B;
      this.hot.emit(s, t);
    }

    // --- 3. smoke ---
    const puffs = Math.min(20, Math.round(6 * sc) + 4);
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * TAU + hash1(n++, 53) * 1.2;
      const rad = hash1(n++, 59);
      const k = hash1(n++, 61);

      s.reset();
      s.x = position.x + Math.cos(a) * rad * 3.5 * sc;
      s.y = position.y + (k - 0.2) * 2.5 * sc;
      s.z = position.z + Math.sin(a) * rad * 3.5 * sc;
      s.vx = Math.cos(a) * (1.5 + rad * 4) * sc;
      s.vy = (7 + k * 13) * sc;
      s.vz = Math.sin(a) * (1.5 + rad * 4) * sc;
      // Staggered: smoke that appears with the flash reads as a grey ball,
      // smoke that blooms out of the dying fireball reads as combustion.
      s.delay = 0.06 + k * 0.45;
      s.life = 1.3 + k * 1.2;
      s.size0 = 5 * sc;
      s.size1 = (9 + k * 14) * sc;
      s.drag = 1.2;
      s.grav = 2.2;
      s.phase = hash1(n++, 67) * TAU;
      s.roll = (k - 0.5) * 1.1;
      s.turb = 4 * sc;
      s.opacity = 0.15 + k * 0.2;
      s.tile = TILE_PUFF;
      s.ca = SMOKE_A;
      s.cb = SMOKE_B;
      this.smoke.emit(s, t);
    }

    // --- physical chunks ---
    const chunks = Math.min(16, Math.round(4 * sc) + 3);
    for (let i = 0; i < chunks; i++) {
      const a = (i / chunks) * TAU + hash1(n++, 71) * 0.9;
      const r = 0.45 + hash1(n++, 73) * 0.75;
      const g = 0.6 + sc * 0.4;
      const spd = (7 + hash1(n++, 79) * 11) * g;
      const ax = hash1(n++, 83) * 2 - 1;
      const ay = hash1(n++, 89) * 2 - 1;
      const az = hash1(n++, 97) * 2 - 1;
      const inv = 1 / Math.max(1e-3, Math.hypot(ax, ay, az));
      this.chunks.emit(
        position.x, position.y, position.z,
        Math.cos(a) * r * spd,
        (10 + hash1(n++, 101) * 14) * g,
        Math.sin(a) * r * spd,
        0.9 + hash1(n++, 103) * 0.8,
        (0.7 + hash1(n++, 107) * 1.0) * (0.85 + sc * 0.35),
        ax * inv, ay * inv, az * inv,
        5 + hash1(n++, 109) * 9,
        t
      );
    }

    this.seq = n;
  }

  /**
   * Gun flash. Two frames at most: at ~9 shots a second anything that lingers
   * stops being an event and becomes a permanent glow welded to the nose.
   *
   * It inherits roughly cruise speed forward, because in the 50 ms it exists the
   * plane travels four units and a world-static flash visibly falls off the gun.
   */
  muzzle(position) {
    const t = this.clock;
    const s = this.s;
    let n = this.seq;

    s.reset();
    s.x = position.x; s.y = position.y; s.z = position.z;
    s.vz = SCALE.cruiseSpeed;
    s.drag = 6;
    s.life = 0.05;
    s.size0 = 2.6;
    s.size1 = 5.2;
    s.phase = hash1(n++, 127) * TAU;
    s.tile = TILE_FLARE;
    s.ca = C.muzzle;
    s.cb = C.tracer;
    this.hot.emit(s, t);

    s.reset();
    s.x = position.x; s.y = position.y; s.z = position.z;
    s.vz = SCALE.cruiseSpeed;
    s.drag = 6;
    s.life = 0.07;
    s.size0 = 1.4;
    s.size1 = 3.4;
    s.phase = hash1(n++, 131) * TAU;
    s.opacity = 0.55;
    s.tile = TILE_PUFF;
    s.ca = C.tracer;
    s.cb = C.mid;
    this.hot.emit(s, t);

    this.seq = n;
  }

  /** Bullet meets something: a hard tick of light and a few sparks. */
  impact(position) {
    const t = this.clock;
    const s = this.s;
    let n = this.seq;

    s.reset();
    s.x = position.x; s.y = position.y; s.z = position.z;
    s.life = 0.1;
    s.size0 = 2;
    s.size1 = 8;
    s.phase = hash1(n++, 137) * TAU;
    s.tile = TILE_FLARE;
    s.ca = C.core;
    s.cb = C.mid;
    this.hot.emit(s, t);

    for (let i = 0; i < 5; i++) {
      const u = hash1(n++, 139) * 2 - 1;
      const a = hash1(n++, 149) * TAU;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      const spd = 14 + hash1(n++, 151) * 18;

      s.reset();
      s.x = position.x; s.y = position.y; s.z = position.z;
      s.vx = Math.cos(a) * r * spd;
      s.vy = (u * 0.4 + 0.6) * spd;
      s.vz = Math.sin(a) * r * spd;
      s.life = 0.22 + hash1(n++, 157) * 0.2;
      s.size0 = 1.0;
      s.size1 = 0.2;
      s.drag = 2;
      s.grav = -GRAVITY * 0.5;
      s.tile = TILE_FLARE;
      s.ca = C.core;
      s.cb = C.tracer;
      this.hot.emit(s, t);
    }

    s.reset();
    s.x = position.x; s.y = position.y; s.z = position.z;
    s.vy = 4;
    s.life = 0.55;
    s.size0 = 1.8;
    s.size1 = 6;
    s.drag = 1.4;
    s.grav = 2;
    s.phase = hash1(n++, 163) * TAU;
    s.roll = 0.8;
    s.opacity = 0.22;
    s.ca = SMOKE_A;
    s.cb = SMOKE_B;
    this.smoke.emit(s, t);

    this.seq = n;
  }

  /**
   * Per frame, after the sim step. Pass the *simulation* clock as `time`
   * (`game.time`, or `game.time + alpha * DT` if you want the effects
   * interpolated like everything else) — see the hitstop note at the top.
   * `dt` is only a fallback for callers that have no sim clock to give.
   */
  update(dt, time) {
    // The clock is driven by the sim clock's *forward* delta rather than by its
    // value, for two reasons. A restart sends game.time back to zero, and a
    // particle's age is (now - birth): rewinding would put every dead particle
    // back in the future and replay the last explosion of the previous life a
    // few seconds into the next one. And the harness fast-forwards the sim by
    // whole minutes between frames, which the clamp absorbs. Zero delta —
    // hitstop — freezes the effects, which is the whole point.
    const now = Number.isFinite(time) ? time : this.clock + dt;
    const step = now - this.prev;
    this.prev = now;
    if (step > 0) this.clock += step < 0.25 ? step : 0.25;

    // Read the fog every frame rather than caching it: phase 2 will animate it,
    // and particles that ignore aerial perspective float in front of the world.
    const fog = this.scene.fog;
    if (fog && fog.isFog) {
      this._fogColor.copy(fog.color);
      this._fogNear = fog.near;
      this._fogFar = fog.far;
    } else if (fog && fog.isFogExp2) {
      // Rough linear stand-in; exponential fog has no near/far to borrow.
      this._fogColor.copy(fog.color);
      this._fogNear = 0;
      this._fogFar = 3 / Math.max(1e-5, fog.density);
    } else {
      this._fogNear = 1e6;
      this._fogFar = 2e6;
    }

    this.hot.update(this.clock, this._fogColor, this._fogNear, this._fogFar);
    this.smoke.update(this.clock, this._fogColor, this._fogNear, this._fogFar);
    this.chunks.update(this.clock);
  }

  dispose() {
    this.hot.dispose(this.scene);
    this.smoke.dispose(this.scene);
    this.chunks.dispose(this.scene);
    this.texture.dispose();
  }
}
