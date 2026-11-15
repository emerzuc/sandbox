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

// Bridges stand every GATE_SPACING units (BRIDGE_SPACING in game/entities.js
// mirrors this), and z = 0 is a gate too: the start line. A sector is the
// water between two gates.
export const GATE_SPACING = 1000;

/**
 * DOUBLE CHANNELS
 *
 * The original River Raid is built out of long, straight, parallel channels:
 * the river forks around a strip of land, the two arms run side by side for a
 * good while, and they rejoin. The first islands here were the opposite —
 * short, dropped into a river that kept meandering underneath them — and the
 * playtest named the result exactly: a channel that is narrow *and* curved.
 *
 * So an island is now a stretch, not a blob. A sector either has one long
 * double channel or none. For as long as it lasts the river stops wandering
 * (the centreline is pulled to where it stands mid-stretch) and stops
 * breathing (the width is held), so both arms are straight, parallel and of
 * constant width, the way the 2600 drew them. The meander and the width ease
 * in and out over a ramp either side, so the river bends *into* the stretch
 * and is straight *through* it.
 *
 * A stretch sits wholly inside its sector, clear of both gates: no island
 * under a bridge, and none where a plane is set down.
 *
 * Sectors alternate: odd ones (1, 3, 5…) are open river, even ones have a
 * double channel. A coin per sector was tried first and gave four doubles in
 * a row, with no open reach for a shore battery until sector 8. Alternating
 * gives each sector a character instead — open water with guns on the banks,
 * then twin channels with ships in them — which is how the original paces
 * itself.
 */
// Far enough past the gate that a plane set down there has three clear seconds
// at cruise before the prow.
const DOUBLE_FROM = 340;
const DOUBLE_TO = 850;
const DOUBLE_RAMP = 140;
/** How much of the meander is taken out. Not all of it: dead straight reads as built. */
const STRAIGHTEN = 0.88;
/** Open water either arm is carved from; wider than the river's own minimum. */
const DOUBLE_HALF_W_MIN = 34;
/**
 * Floor under the narrower arm. The plane is 13 across; at 24 an arm was under
 * two plane-widths and read as a slot from the cockpit. The original's arms
 * are nearer three.
 */
const ARM_MIN = 28;
/** The strip of land, as a fraction of the base half-width. */
const ISLAND_FRAC = 0.42;
/** A steep prow reads as a rock face from far off; the tail tapers away. */
const PROW_LEN = 30;
const TAIL_LEN = 90;

function meander(z) {
  return (fbm1(z * 0.0016, WORLD_SEED, 3) - 0.5) * 2 * MEANDER_AMP;
}

function wanderingHalfWidth(z) {
  const n = fbm1(z * 0.0031 + 100, WORLD_SEED ^ 77, 3);
  return lerp(HALF_W_MIN, HALF_W_MAX, clamp01((n - 0.2) / 0.6));
}

// Memo only: a stretch is a pure function of its sector index, and this is
// asked for on every vertex of every terrain chunk.
const stretches = new Map();

/** The double channel of sector k (0-based), or null. */
function stretchOf(k) {
  let s = stretches.get(k);
  if (s !== undefined) return s;
  s = null;
  if (k >= 1 && k % 2 === 1) {
    const from = k * GATE_SPACING + DOUBLE_FROM;
    const to = k * GATE_SPACING + DOUBLE_TO;
    const mid = (from + to) / 2;
    const base = Math.max(wanderingHalfWidth(mid), DOUBLE_HALF_W_MIN);
    const dir = hash1(k, WORLD_SEED ^ 4242) < 0.5 ? -1 : 1;
    s = {
      from,
      to,
      cx: meander(mid),
      base,
      // Off-centre, so one arm is the roomier line — but never by enough to
      // starve the other below ARM_MIN.
      off: dir * Math.min(base * 0.18, Math.max(0, base - ARM_MIN)),
      hw: base * ISLAND_FRAC,
    };
  }
  stretches.set(k, s);
  return s;
}

/** Public view of a sector's double channel: { from, to } in world z, or null. */
export function doubleChannel(sectorIndex) {
  const s = stretchOf(sectorIndex);
  return s ? { from: s.from, to: s.to } : null;
}

/** 0 outside the stretch and its ramps, 1 inside it. */
function hold(z, s) {
  if (z <= s.from - DOUBLE_RAMP || z >= s.to + DOUBLE_RAMP) return 0;
  if (z < s.from) return smoothstep((z - (s.from - DOUBLE_RAMP)) / DOUBLE_RAMP);
  if (z > s.to) return smoothstep((s.to + DOUBLE_RAMP - z) / DOUBLE_RAMP);
  return 1;
}

/** Lateral position of the river's centreline at distance z. */
export function riverCenterX(z) {
  const m = meander(z);
  const s = stretchOf(Math.floor(z / GATE_SPACING));
  if (!s) return m;
  const w = hold(z, s);
  return w > 0 ? m + (s.cx - m) * w * STRAIGHTEN : m;
}

/** Width of open water before an island is carved out of it. */
function baseHalfWidth(z) {
  const b = wanderingHalfWidth(z);
  const s = stretchOf(Math.floor(z / GATE_SPACING));
  if (!s) return b;
  const w = hold(z, s);
  return w > 0 ? b + (s.base - b) * w : b;
}

/**
 * The strip of land at z: { amt, off, hw }, amt 0 where there is none.
 *
 * The island *displaces* water rather than blocking it: riverHalfWidth grows
 * by exactly the island's width, which makes each arm `base ± off` wide,
 * independent of how fat the island is. Clamping `off` therefore puts a hard
 * floor under the narrower arm.
 */
export function islandAt(z) {
  const s = stretchOf(Math.floor(z / GATE_SPACING));
  if (!s || z <= s.from || z >= s.to) return ISLAND_NONE;
  const head = smoothstep(clamp01((z - s.from) / PROW_LEN));
  const tail = 1 - smoothstep(clamp01((z - (s.to - TAIL_LEN)) / TAIL_LEN));
  return { amt: head * tail, off: s.off, hw: s.hw };
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
export function pickChannelX(z, rnd, margin = 5, arm = -1) {
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
  // `arm` 0 or 1 names the side outright (low-x arm is 0). The die is rolled
  // regardless, so asking for a side does not shift the caller's stream.
  const roll = rnd();
  const useLeft = arm >= 0 ? arm === 0 : roll < (leftSpan > rightSpan ? 0.65 : 0.35);
  const lo = useLeft ? cx - hw : icx + ihw;
  const hi = useLeft ? icx - ihw : cx + hw;
  if (hi - lo <= margin * 2) return null;
  return lerp(lo + margin, hi - margin, rnd());
}
