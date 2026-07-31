import { fbm1, fbm2, hash1 } from '../core/rng.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';

/**
 * The world is a pure function of (x, z). Nothing is baked, nothing is stored.
 * That buys three things:
 *   - infinite terrain with no authoring,
 *   - exact collision (we query the same function the mesh was built from,
 *     so there is no mesh-vs-collider drift),
 *   - determinism, which the whole verification story rests on.
 *
 * Forward is +Z. Lateral is X. Water sits at y = 0.
 */

export const WORLD_SEED = 1337;

export const WATER_Y = 0;
export const RIVER_DEPTH = 7;
export const BANK_HEIGHT = 15;
export const WORLD_HALF_W = 165;

const MEANDER_AMP = 46;

/**
 * Minimum channel half-width. The plane is 13 units across and collision is
 * sampled at the wingtips (10.4 units), so this single number decides whether
 * the tightest gorge in the world is flyable at all — and, once an island
 * splits it, whether the *narrower half* is still flyable. 21 leaves ~10 units
 * of total slack in the worst case: tense, but it survives a dodge.
 */
const HALF_W_MIN = 21;
const HALF_W_MAX = 38;

const ISLAND_BAND = 460;
const ISLAND_FRAC = 0.3;

/** Lateral position of the river's centreline at distance z. */
export function riverCenterX(z) {
  return (fbm1(z * 0.0016, WORLD_SEED, 3) - 0.5) * 2 * MEANDER_AMP;
}

/** Width of open water before an island is carved out of it. */
function baseHalfWidth(z) {
  const n = fbm1(z * 0.0031 + 100, WORLD_SEED ^ 77, 3);
  return lerp(HALF_W_MIN, HALF_W_MAX, clamp01((n - 0.2) / 0.6));
}

/**
 * Islands split the channel in two and force a commit. They appear in bands so
 * the player gets a rhythm of open water / choice / open water rather than
 * uniform noise.
 *
 * The island *displaces* water rather than blocking it: riverHalfWidth grows by
 * exactly the island's width, which makes each resulting channel `base ± off`
 * wide, independent of how fat the island is. Clamping `off` therefore puts a
 * hard floor under the narrower channel — an island can never produce a gap the
 * plane cannot fit through.
 */
export function islandAt(z) {
  const band = Math.floor(z / ISLAND_BAND);
  if (hash1(band, WORLD_SEED ^ 9001) < 0.45) return ISLAND_NONE;

  const local = (z - band * ISLAND_BAND) / ISLAND_BAND;
  const t = clamp01((local - 0.18) / 0.5);
  if (t <= 0 || t >= 1) return ISLAND_NONE;

  const amt = Math.sin(Math.PI * t);
  const base = baseHalfWidth(z);
  const dir = hash1(band, WORLD_SEED ^ 4242) < 0.5 ? -1 : 1;

  return {
    amt,
    // Bias the island off-centre so one channel is the obvious line — but never
    // far enough to starve the other one below HALF_W_MIN.
    off: dir * Math.min(base * 0.25, Math.max(0, base - HALF_W_MIN)),
    hw: base * ISLAND_FRAC,
  };
}

const ISLAND_NONE = { amt: 0, off: 0, hw: 0 };

/** Half-width of the wetted channel, island included. */
export function riverHalfWidth(z) {
  const isl = islandAt(z);
  return baseHalfWidth(z) + isl.hw * isl.amt;
}

/**
 * Signed distance to the shoreline, in world units.
 * Negative = over water (safe). Positive = over land (fatal).
 */
export function shoreSDF(x, z) {
  const cx = riverCenterX(z);
  const hw = riverHalfWidth(z);
  let sd = Math.abs(x - cx) - hw;

  const isl = islandAt(z);
  if (isl.amt > 0) {
    const ihw = isl.hw * isl.amt;
    sd = Math.max(sd, ihw - Math.abs(x - (cx + isl.off)));
  }
  return sd;
}

/**
 * Terrain elevation. Continuous across the shoreline (every term vanishes at
 * sd = 0), so the mesh has no crack where the riverbed meets the bank.
 */
export function terrainHeight(x, z) {
  const sd = shoreSDF(x, z);

  if (sd < 0) {
    // Riverbed: dish downward away from the shore.
    return WATER_Y - RIVER_DEPTH * smoothstep(clamp01(-sd / 13));
  }

  const rise = BANK_HEIGHT * smoothstep(clamp01(sd / 16));
  // Hills only take hold well inland, so the shoreline reads as a clean edge.
  const inland = clamp01((sd - 10) / 45);
  const hills = (fbm2(x * 0.011, z * 0.011, WORLD_SEED ^ 555, 4) - 0.3) * 46 * inland;
  const ridge = (fbm2(x * 0.0034, z * 0.0034, WORLD_SEED ^ 31, 2) - 0.25) * 70 * inland * inland;

  // The relief noise is signed, so inland valleys used to dip below y = 0 and
  // get flooded by the water quad — phantom lakes a kilometre from the river.
  // Floor the land just above the waterline; the floor itself fades out at the
  // shore so the surface stays continuous across sd = 0.
  const floor = 1.2 * smoothstep(clamp01(sd / 16));
  return WATER_Y + Math.max(rise + hills + ridge, floor);
}

/**
 * Random x inside the channel at z, avoiding the island and keeping `margin`
 * clear of both shores. Returns null when the gap is too tight to place in.
 */
export function pickChannelX(z, rnd, margin = 5) {
  const cx = riverCenterX(z);
  const hw = riverHalfWidth(z);
  const isl = islandAt(z);

  if (isl.amt <= 0) {
    const span = hw - margin;
    if (span <= 0) return null;
    return cx + (rnd() * 2 - 1) * span;
  }

  // Two channels: pick the wider one most of the time.
  const ihw = isl.hw * isl.amt;
  const icx = cx + isl.off;
  const leftSpan = icx - ihw - (cx - hw);
  const rightSpan = cx + hw - (icx + ihw);
  const useLeft = rnd() < (leftSpan > rightSpan ? 0.65 : 0.35);
  const lo = useLeft ? cx - hw : icx + ihw;
  const hi = useLeft ? icx - ihw : cx + hw;
  if (hi - lo <= margin * 2) return null;
  return lerp(lo + margin, hi - margin, rnd());
}
