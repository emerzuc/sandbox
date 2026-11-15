import { guardFlatNormals } from '../view/shaderGuards.js';
import * as THREE from 'three';
import { PALETTE, ATMOSPHERE, SCALE, biomeAt } from '../art/direction.js';
import { clamp01, smoothstep } from '../core/math.js';
import { valueNoise2, hash2 } from '../core/rng.js';
import { WORLD_SEED, riverCenterX, riverHalfWidth, islandAt, terrainHeight } from './river.js';

/**
 * Terrain look. Box art, not pixels: the landscape is painted per-vertex from
 * quantities the world function already knows about — slope, altitude, distance
 * to the shore, and a cheap baked occlusion — and then lit by one raking sun.
 *
 * Everything expensive happens once per chunk on the CPU (`decorateGeometry`),
 * because a chunk is built once and drawn for ~10 seconds of flight. The shader
 * only spends per-pixel work on what cannot be baked: splitting the occlusion
 * between direct and indirect light, the bounce off the sunlit gorge wall, and
 * aerial haze.
 *
 * FLAT SHADING IS KEPT, deliberately. It was doing real work in the greybox and
 * it does more work now: with a 2-unit grid the facets are small enough to read
 * as rock rather than as low-poly, and a hard value step between adjacent facets
 * under a low sun is exactly the airbrushed-cliff look the box art has. Smooth
 * normals at this density turn every cliff into a soft gradient and — worse —
 * round off the bank, which rises over only ~16 units of shore distance and is
 * the one silhouette the player reads at speed. Colour, unlike lighting, still
 * interpolates across the facet, so the terrain gets faceted light over smooth
 * paint instead of visible per-triangle blotches.
 */

// ---------------------------------------------------------------- palette prep

/**
 * The five paint colours for the vertex row being painted, linear (biomeAt
 * hands over Colors already converted from hex; vertex colours are never sRGB).
 *
 * Refilled from biomeAt(z) once per row rather than once per module: the biome
 * is a function of z, and a chunk is painted once and never repainted, so the
 * row is the finest grain at which the blend band can be sampled without
 * paying per vertex. Per row is ~60 calls a chunk, a few microseconds; per
 * chunk would step the blend by 120/BIOME_BLEND = 30 % between neighbours and
 * draw the seam the wide band exists to hide. Inside a band the five arrive
 * already interpolated, so the partition below never changes shape — it only
 * mixes what it is handed, and it still cannot produce a hue that is not one
 * of the five.
 */
const PAINT = new Float64Array(15);
const P_SAND = 0;
const P_LIT = 3;
const P_SHADOW = 6;
const P_CLIFF = 9;
const P_HIGH = 12;

function loadPaint(z) {
  const b = biomeAt(z);
  let c = b.sand;
  PAINT[P_SAND] = c.r; PAINT[P_SAND + 1] = c.g; PAINT[P_SAND + 2] = c.b;
  c = b.rockLit;
  PAINT[P_LIT] = c.r; PAINT[P_LIT + 1] = c.g; PAINT[P_LIT + 2] = c.b;
  c = b.rockShadow;
  PAINT[P_SHADOW] = c.r; PAINT[P_SHADOW + 1] = c.g; PAINT[P_SHADOW + 2] = c.b;
  c = b.rockCliff;
  PAINT[P_CLIFF] = c.r; PAINT[P_CLIFF + 1] = c.g; PAINT[P_CLIFF + 2] = c.b;
  c = b.rockHigh;
  PAINT[P_HIGH] = c.r; PAINT[P_HIGH + 1] = c.g; PAINT[P_HIGH + 2] = c.b;
}

const SUN = (() => {
  const [x, y, z] = PALETTE.sunDirection;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();

const B = SCALE.bankHeight;
const RW = SCALE.riverWidthTypical;

/** smoothstep that clamps first — math.js leaves the clamp to the caller. */
const sstep = (t) => smoothstep(clamp01(t));

// Ramp endpoints for the paint, as reciprocals so the hot loop has no divides.
// Altitudes are in bank heights and shore distances in typical river widths, so
// the paint follows if the world's scale is ever retuned.
//
// The thresholds are measured against the terrain the generator actually makes,
// not against an imagined one. Over 400k sampled vertices the median slope is
// 0.05 and only 4 % ever exceed 0.40 — so the obvious-looking cliff threshold of
// 0.4 selected almost nothing and left the whole valley one flat orange.
const FACE_LO = -0.1; // dot(n, sun) at which rock starts warming up
const FACE_INV = 1 / 0.7;
/**
 * Ceiling on how much rockShadow a sun-averted face may take. PALETTE.rockLit
 * and PALETTE.rockShadow describe how rock should *look* lit and shadowed, not
 * two albedos — painting a face rockShadow *and* then lighting it with ambient
 * alone applies the shadow twice and lands on black, which is the one thing the
 * box art never does. The paint tints; the sun and the shadow map do the rest.
 */
const SHADE_MAX = 0.55;
const SLOPE_CLIFF_LO = 0.22; // ~top 13 % of slopes
const SLOPE_CLIFF_INV = 1 / 0.22; // fully cliff at 0.44, ~top 2 %
const SLOPE_FLAT_INV = 1 / 0.22;
const SLOPE_SHORE_INV = 1 / 0.55; // loose: the bank rise itself should keep sand
const ALT_SAND_LO = 0.15 * B;
const ALT_SAND_INV = 1 / (0.75 * B);
const ALT_HIGH_LO = 1.5 * B; // ~median altitude
const ALT_HIGH_INV = 1 / (2.2 * B); // fully pale at ~55, the top 8 % of ridges
const SHORE_LO = 0.02 * RW;
const SHORE_INV = 1 / (0.10 * RW);

const NOISE_SEED = WORLD_SEED ^ 0x5eed;
const NOISE_FREQ = 0.03; // ~33-unit patches: bigger than a facet, smaller than a hill
const NOISE_PATCH = 0.20;
const NOISE_GRAIN = 0.07;

// ------------------------------------------------------------------ occlusion

/**
 * Occlusion is "how low is this vertex compared to the land around it", at two
 * scales. It is not a real visibility integral, but it puts darkness in the
 * bottom of the valley and light on the ridges, which is the only thing the eye
 * actually uses to judge depth in a stylised frame — and it is what makes the
 * gorge read as deep rather than as a groove.
 *
 * It is computed on a coarse grid sampled from the height function rather than
 * from the chunk's own vertices, for two reasons: ~550 samples instead of
 * 10 000, and — the important one — the grid is padded by OCC_MARGIN beyond the
 * chunk, so the blur never clamps inside the chunk and neighbouring chunks
 * agree exactly at the seam. Clamping at the chunk edge would draw a bright
 * stripe across the world every CHUNK_LEN units.
 *
 * The grid is coarse because the blur throws away everything finer anyway: the
 * narrower of the two windows is already 100 units across, five times the step.
 */
const OCC_STEP = 20;
const OCC_R_NEAR = 2; // cells -> 100-unit window, river-corridor scale
const OCC_R_FAR = 5; // cells -> 220-unit window, hill / ridge scale
const OCC_MARGIN = OCC_R_FAR * OCC_STEP; // exactly the reach of the wider blur
/**
 * Deepest the bake is allowed to go. The sun is the only key light and the
 * ambient is a sixth of it, so a shadowed slope has very little to lose before
 * it is simply black; the floor is what keeps the gorge reading as deep ground
 * rather than as a hole cut in the frame.
 */
const OCC_FLOOR = 0.45;
const OCC_NEAR_INV = 1 / (1.5 * B);
const OCC_FAR_INV = 1 / (4 * B);
const OCC_NEAR_MIX = 0.42;
const INV_OCC_STEP = 1 / OCC_STEP;

let gW = 0;
let gH = 0;
let gRaw = null;
let gA = null;
let gB = null;
let gTmp = null;
/** Both blurred fields interleaved, so a vertex indexes the pair once. */
let gPair = null;

function ensureGrid(w, h) {
  if (w === gW && h === gH) return;
  gW = w;
  gH = h;
  gRaw = new Float32Array(w * h);
  gA = new Float32Array(w * h);
  gB = new Float32Array(w * h);
  gTmp = new Float32Array(w * h);
  gPair = new Float32Array(w * h * 2);
}

/** Separable box blur, edge-clamped. O(n) in the number of cells, radius-free. */
function boxBlur(src, dst, tmp, w, h, r) {
  const inv = 1 / (2 * r + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : k > w - 1 ? w - 1 : k)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      const add = x + r + 1 > w - 1 ? w - 1 : x + r + 1;
      const sub = x - r < 0 ? 0 : x - r;
      sum += src[row + add] - src[row + sub];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : k > h - 1 ? h - 1 : k) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      const add = y + r + 1 > h - 1 ? h - 1 : y + r + 1;
      const sub = y - r < 0 ? 0 : y - r;
      sum += tmp[add * w + x] - tmp[sub * w + x];
    }
  }
}

// ------------------------------------------------------------- surface normal

/**
 * The paint cannot use the geometry's own vertex normals.
 *
 * `computeVertexNormals` averages the faces a vertex touches, and on the first
 * and last row of a chunk half those faces are in the *next* chunk and do not
 * exist yet. The two coincident rows at a seam therefore get different normals —
 * measured at up to 0.61 apart — and since slope and sun-facing both drive the
 * palette mix, that painted a bright or dark line across the valley every
 * CHUNK_LEN units. Flat shading hid it in the lighting but not in the colour.
 *
 * So the paint takes its normal from a central difference of the height grid
 * instead. That is a pure function of world position, so both sides of a seam
 * agree exactly, and it is the true surface gradient rather than an average of
 * whichever triangles happened to be built. The only samples that are not
 * already in the vertex buffer are the two rows just outside the chunk: about
 * 330 extra calls, against the 10 000 the mesh build already paid.
 */
function inferGrid(pos, count) {
  const firstX = pos[0];
  let cols = 0;
  for (let i = 1; i < count; i++) {
    // x ascends across a row and resets at the start of the next one.
    if (pos[i * 3] <= firstX) { cols = i; break; }
  }
  if (cols < 3 || count % cols !== 0) return null;
  const rows = count / cols;
  if (rows < 3) return null;
  return { cols, rows };
}

let edgeLo = null;
let edgeHi = null;

// ------------------------------------------------------------------ decorate

/**
 * Called once per streamed chunk, after positions and vertex normals exist.
 * Attaches `color` (the painted albedo, linear) and `aShade`
 * (x = baked occlusion, y = sun facing).
 */
export function decorateGeometry(geometry) {
  const posAttr = geometry.getAttribute('position');
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const nrmAttr = geometry.getAttribute('normal');

  const pos = posAttr.array;
  const nrm = nrmAttr.array;
  const count = posAttr.count;

  // --- bounds, so the occlusion grid covers exactly this chunk plus margin ---
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3];
    const z = pos[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  // Snap the grid origin to a global lattice. Two neighbouring chunks then
  // sample the height function at *identical* world positions in their overlap,
  // so their blurred fields agree bit for bit and the seam is invisible. An
  // unsnapped origin only works when OCC_STEP happens to divide CHUNK_LEN.
  const x0 = Math.floor((minX - OCC_MARGIN) / OCC_STEP) * OCC_STEP;
  const z0 = Math.floor((minZ - OCC_MARGIN) / OCC_STEP) * OCC_STEP;
  // +2 cells of slack. That is what lets the per-vertex bilinear below skip its
  // bounds checks entirely: every vertex lands at grid coordinate >= OCC_R_FAR
  // and <= w - 2 - OCC_R_FAR, so the taps and their blur windows are in range.
  const w = Math.ceil((maxX + OCC_MARGIN - x0) / OCC_STEP) + 2;
  const h = Math.ceil((maxZ + OCC_MARGIN - z0) / OCC_STEP) + 2;
  ensureGrid(w, h);

  for (let j = 0; j < h; j++) {
    const z = z0 + j * OCC_STEP;
    const row = j * w;
    for (let i = 0; i < w; i++) {
      gRaw[row + i] = terrainHeight(x0 + i * OCC_STEP, z);
    }
  }
  boxBlur(gRaw, gA, gTmp, w, h, OCC_R_NEAR);
  boxBlur(gRaw, gB, gTmp, w, h, OCC_R_FAR);
  for (let i = 0, n = w * h; i < n; i++) {
    gPair[i * 2] = gA[i];
    gPair[i * 2 + 1] = gB[i];
  }
  const rowStride = w * 2;

  // --- surface gradient ----------------------------------------------------
  const grid = inferGrid(pos, count);
  let cols = 0;
  let dxInv = 0;
  let dxInvEdge = 0;
  let dzInv = 0;
  if (grid) {
    cols = grid.cols;
    const dx = pos[3] - pos[0];
    const dz = pos[cols * 3 + 2] - pos[2];
    dxInv = 0.5 / dx;
    dzInv = 0.5 / dz;
    dxInvEdge = 1 / dx;
    if (!edgeLo || edgeLo.length < cols) {
      edgeLo = new Float32Array(cols);
      edgeHi = new Float32Array(cols);
    }
    const zLo = pos[2] - dz;
    const zHi = pos[(count - 1) * 3 + 2] + dz;
    for (let c = 0; c < cols; c++) {
      const xc = pos[c * 3];
      edgeLo[c] = terrainHeight(xc, zLo);
      edgeHi[c] = terrainHeight(xc, zHi);
    }
  }

  // --- paint ---------------------------------------------------------------
  const col = new Float32Array(count * 3);
  // vec2: x = baked occlusion, y = how much the vertex faces the sun.
  const shade = new Float32Array(count * 2);

  // The shore terms and the biome paint depend only on z, and the chunk builder
  // emits vertices row-major with z constant across a row: ~60 evaluations per
  // chunk instead of 10 000. Falls back to recomputing per vertex if the order
  // ever changes.
  let lastZ = NaN;
  let col0 = 0; // column index, stepped rather than derived with a modulo
  let cx = 0;
  let hw = 0;
  let iAmt = 0;
  let iOff = 0;
  let iHw = 0;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const x = pos[i3];
    const y = pos[i3 + 1];
    const z = pos[i3 + 2];

    if (z !== lastZ) {
      lastZ = z;
      loadPaint(z);
      cx = riverCenterX(z);
      hw = riverHalfWidth(z);
      const isl = islandAt(z);
      iAmt = isl.amt;
      iOff = isl.off;
      iHw = isl.hw * isl.amt;
    }

    // Same signed distance the collision uses, so paint and gameplay agree.
    let sd = Math.abs(x - cx) - hw;
    if (iAmt > 0) sd = Math.max(sd, iHw - Math.abs(x - (cx + iOff)));

    let nx;
    let ny;
    let nz;
    if (grid) {
      const c = col0;
      if (++col0 === cols) col0 = 0;
      const hxm = pos[(c > 0 ? i3 - 3 : i3) + 1];
      const hxp = pos[(c < cols - 1 ? i3 + 3 : i3) + 1];
      const hzm = i >= cols ? pos[i3 - cols * 3 + 1] : edgeLo[c];
      const hzp = i + cols < count ? pos[i3 + cols * 3 + 1] : edgeHi[c];
      // The world's edge columns get a one-sided difference over half the step;
      // they are outside the play area and never on screen.
      const gx = (hxp - hxm) * (c > 0 && c < cols - 1 ? dxInv : dxInvEdge);
      const gz = (hzp - hzm) * dzInv;
      const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      nx = -gx * inv;
      ny = inv;
      nz = -gz * inv;
    } else {
      nx = nrm[i3];
      ny = nrm[i3 + 1];
      nz = nrm[i3 + 2];
    }

    const slope = clamp01(1 - ny);

    // --- how much of each palette entry is in this vertex --------------------
    //
    // Written as a chain of blends and then collapsed into weights, rather than
    // as four sequential lerps over three channels. Same result, a third of the
    // arithmetic, and it says out loud what the paint actually is: a partition
    // of five palette colours. Nothing here can produce a hue that is not one of
    // them, which is the rule the whole art direction rests on.

    // How much the face turns toward the sun. A *paint* term, not a lighting
    // one: it gives the warm/cool rock split even where the sun never lands,
    // which is what stops shadowed cliffs going muddy.
    const facing = sstep((nx * SUN[0] + ny * SUN[1] + nz * SUN[2] - FACE_LO) * FACE_INV);
    // Steep faces go to bare cliff.
    const tCliff = sstep((slope - SLOPE_CLIFF_LO) * SLOPE_CLIFF_INV);
    // High ridges bleach out. Damped on cliffs so the pale tone lands on ridge
    // lines rather than on every tall wall.
    const tHigh = sstep((y - ALT_HIGH_LO) * ALT_HIGH_INV) * (1 - tCliff * 0.65);
    // Sand: low flat ground anywhere, plus a hard band at the waterline. The
    // shore term is tight on purpose (~1 -> 6 units of shore distance, three
    // vertices) because that edge is the read the whole game depends on. The
    // altitude term alone will not do: inland valley floors also bottom out
    // just above the waterline and would come out as sand a kilometre inland.
    const tLow =
      (1 - sstep((y - ALT_SAND_LO) * ALT_SAND_INV)) * (1 - sstep(slope * SLOPE_FLAT_INV));
    const tShore =
      (1 - sstep((sd - SHORE_LO) * SHORE_INV)) * (1 - sstep(slope * SLOPE_SHORE_INV));
    const tSand = tLow > tShore ? tLow : tShore;

    const k1 = 1 - tSand;
    const wHigh = k1 * tHigh;
    const k2 = k1 - wHigh;
    const wCliff = k2 * tCliff;
    const k3 = k2 - wCliff;
    const wShadow = k3 * (1 - facing) * SHADE_MAX;
    const wLit = k3 - wShadow;

    // Same operand order as the pre-biome paint: in biome 0 PAINT holds PALETTE
    // verbatim and this must come out bit-identical, so nothing is reassociated.
    const r = PAINT[P_SAND] * tSand + PAINT[P_HIGH] * wHigh + PAINT[P_CLIFF] * wCliff +
      PAINT[P_LIT] * wLit + PAINT[P_SHADOW] * wShadow;
    const g = PAINT[P_SAND + 1] * tSand + PAINT[P_HIGH + 1] * wHigh + PAINT[P_CLIFF + 1] * wCliff +
      PAINT[P_LIT + 1] * wLit + PAINT[P_SHADOW + 1] * wShadow;
    const b = PAINT[P_SAND + 2] * tSand + PAINT[P_HIGH + 2] * wHigh + PAINT[P_CLIFF + 2] * wCliff +
      PAINT[P_LIT + 2] * wLit + PAINT[P_SHADOW + 2] * wShadow;

    // Value-only break-up: a scalar multiply cannot introduce a hue that is not
    // already in the palette. Two terms, because they fix different failures —
    // the smooth one puts patches across a 300-unit cliff so it stops reading as
    // one stroke of flat paint, the per-vertex grain (free: the vertices sit on
    // an integer lattice, so one hash is enough) breaks the smooth ramps that
    // otherwise band across a whole hillside.
    const v =
      1 +
      (valueNoise2(x * NOISE_FREQ, z * NOISE_FREQ, NOISE_SEED) - 0.5) * NOISE_PATCH +
      (hash2(x, z, NOISE_SEED ^ 0x51ed) - 0.5) * NOISE_GRAIN;
    col[i3] = r * v;
    col[i3 + 1] = g * v;
    col[i3 + 2] = b * v;

    // --- occlusion: one bilinear fetch of the interleaved pair --------------
    const gx = (x - x0) * INV_OCC_STEP;
    const gz = (z - z0) * INV_OCC_STEP;
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const o = iz * rowStride + ix * 2;
    const o2 = o + rowStride;
    const aN = gPair[o] + (gPair[o + 2] - gPair[o]) * fx;
    const bN = gPair[o2] + (gPair[o2 + 2] - gPair[o2]) * fx;
    const aF = gPair[o + 1] + (gPair[o + 3] - gPair[o + 1]) * fx;
    const bF = gPair[o2 + 1] + (gPair[o2 + 3] - gPair[o2 + 1]) * fx;

    const rNear = clamp01(0.5 + (y - (aN + (bN - aN) * fz)) * OCC_NEAR_INV);
    const rFar = clamp01(0.5 + (y - (aF + (bF - aF) * fz)) * OCC_FAR_INV);
    shade[i * 2] =
      OCC_FLOOR +
      (1 - OCC_FLOOR) * (OCC_NEAR_MIX * rNear + (1 - OCC_NEAR_MIX) * rFar);
    shade[i * 2 + 1] = facing;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geometry.setAttribute('aShade', new THREE.BufferAttribute(shade, 2));
}

// ------------------------------------------------------------------- material

/**
 * How much of the baked occlusion reaches each light path. Not 1.0 even for the
 * ambient: with this key-to-fill ratio, full occlusion on the fill crushes every
 * shadowed slope to black. The point of the bake is to shape depth, not to
 * remove light.
 */
const AO_INDIRECT = 0.85;
const AO_DIRECT = 0.30;

/**
 * Bounce off the sunlit gorge wall, onto the one in shade.
 *
 * This is not decoration, it is missing physics. In a valley this steep the lit
 * wall is a huge warm secondary source aimed straight at the dark wall, and
 * neither a hemisphere light (sky above, ground below) nor a shadow map can
 * express it. Without it the maths is unarguable and the picture is wrong: a
 * hemisphere fill of PALETTE.ambientIntensity against a sun of
 * PALETTE.sunIntensity renders the shaded bank at about 1/255 through ACES —
 * measured, not estimated. Black is deep, but the brief asks for shadows that
 * are deep *and* coloured, and there is no colour in black.
 *
 * The tint is the biome's ambientGround, which the palette already names as the
 * warm ground bounce, so this introduces no new hue — and it follows the biome
 * for the same reason it exists: a dark basalt wall throws less light back than
 * an amber one. Set BOUNCE to 0 to switch the whole effect off and get the
 * literal reading of the palette back.
 */
const BOUNCE = 1.8;

/**
 * The uniforms that travel with the biome, owned here at module scope so the
 * material's compiled program references them directly and a change lands
 * without anybody keeping a handle on the material. Seeded with the amber
 * desert so the first frame is exactly what it was before biomes.
 */
const ATMO = {
  uHazeColor: { value: new THREE.Color(ATMOSPHERE.fogColor) },
  uHazeStrength: { value: ATMOSPHERE.hazeStrength },
  uHazeNear: { value: ATMOSPHERE.fogNear * 0.4 },
  uHazeFar: { value: ATMOSPHERE.fogFar },
  uBounce: { value: new THREE.Color(PALETTE.ambientGround).multiplyScalar(BOUNCE) },
};

/**
 * Called by the light rig once per frame with its *damped* atmosphere — not
 * with biomeAt() directly — so the haze painted on the rock and the fog in the
 * air are the same air at the same moment. The haze's near distance keeps the
 * 0.4 × fogNear relation it was tuned with. Copies in, holds no references.
 */
export function setTerrainAtmosphere(fogColor, fogNear, fogFar, hazeStrength, ambientGround) {
  ATMO.uHazeColor.value.copy(fogColor);
  ATMO.uHazeStrength.value = hazeStrength;
  ATMO.uHazeNear.value = fogNear * 0.4;
  ATMO.uHazeFar.value = fogFar;
  ATMO.uBounce.value.copy(ambientGround).multiplyScalar(BOUNCE);
}

export function createTerrainMaterial() {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // See the module header: the facets are the art.
    flatShading: true,
    roughness: 0.94,
    metalness: 0,
    // The sky-to-fog gradient across a kilometre of hillside banks badly at
    // 8 bits; dithering is the cheapest fix there is.
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    guardFlatNormals(shader);
    shader.uniforms.uAoDirect = { value: AO_DIRECT };
    shader.uniforms.uAoIndirect = { value: AO_INDIRECT };
    // Shared, not copied: these are the live biome uniforms (see ATMO).
    shader.uniforms.uHazeColor = ATMO.uHazeColor;
    shader.uniforms.uHazeStrength = ATMO.uHazeStrength;
    shader.uniforms.uHazeNear = ATMO.uHazeNear;
    shader.uniforms.uHazeFar = ATMO.uHazeFar;
    shader.uniforms.uBounce = ATMO.uBounce;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aShade;
        varying vec2 vShade;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vShade = aShade;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uAoDirect;
        uniform float uAoIndirect;
        uniform vec3 uHazeColor;
        uniform float uHazeStrength;
        uniform float uHazeNear;
        uniform float uHazeFar;
        uniform vec3 uBounce;
        varying vec2 vShade;`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        // Occlusion is a sky-visibility term, so it belongs almost entirely to
        // the ambient. Letting a little of it touch the sun keeps the gorge
        // floor from flattening out when the sun rakes straight down it.
        reflectedLight.indirectDiffuse *= mix( 1.0, vShade.x, uAoIndirect );
        reflectedLight.directDiffuse *= mix( 1.0, vShade.x, uAoDirect );
        // Bounce from the lit wall. Strongest exactly where the sun is not:
        // it fills the terminator instead of doubling up on it. Occluded by the
        // same bake, so it never lifts the bottom of the gorge back out.
        reflectedLight.indirectDiffuse +=
          uBounce * ( 1.0 - vShade.y ) * vShade.x * diffuseColor.rgb;`
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        // Aerial perspective on top of the linear fog: quadratic, so the near
        // field stays saturated and the far ridges wash to the warm horizon
        // hue instead of everything fading uniformly. Applied here, before tone
        // mapping, so the haze is graded with the rest of the frame.
        #ifdef USE_FOG
          float hz = clamp( ( vFogDepth - uHazeNear ) / ( uHazeFar - uHazeNear ), 0.0, 1.0 );
          gl_FragColor.rgb = mix( gl_FragColor.rgb, uHazeColor, hz * hz * uHazeStrength );
        #endif`
      );
  };

  return material;
}
