/**
 * ART DIRECTION — single source of truth. Fase 2.
 *
 * "Box art, not pixels": the retrofit is not of the Atari 2600's pixels, it is
 * of the airbrushed sci-fi promise the 1982 cartridge box made to a kid who
 * then went home and played six coloured blocks. Dramatic valley, raking low
 * sun, tiny plane against an enormous landscape, saturated sky, hard silhouettes.
 *
 * This choice is deliberately NOT photoreal. The browser loses that comparison,
 * and a stylised, high-contrast, atmosphere-led look plays to what Three.js is
 * actually good at: silhouette, scale, colour and light. No skin, no cloth, no
 * faces — none of the things that break down at this budget.
 *
 * RULES FOR EVERY MODULE
 *   - Never hardcode a colour. Import it from here.
 *   - Never introduce a hue outside this palette. Coherence is the whole point:
 *     it is the difference between "art directed" and "six people guessed".
 *   - Values are linear-space friendly; the renderer runs ACES tone mapping at
 *     the exposure below.
 *
 * Changing the look of the whole game should mean editing this file and nothing
 * else. If it doesn't, something downstream has cheated.
 *
 * PALETTE and ATMOSPHERE below are the amber desert of sectors 1–2. The BIOMES
 * table at the bottom re-colours a subset of them for later sectors; consumers
 * that travel with the player read `biomeAt(z)` instead of the tables directly.
 */

import * as THREE from 'three';

/** Hex is authoring-friendly; convert with new THREE.Color(...) at use site. */
export const PALETTE = {
  // --- Sky: the amber-to-turquoise gradient the box art is built on ---
  skyZenith: 0x2c6d8f,
  skyHorizon: 0xdca66c,
  skyMid: 0x7d9a8d,

  // --- Sun: low and raking, never overhead. Long shadows are the point. ---
  sunColor: 0xffd6a0,
  sunIntensity: 3.4,
  /** Normalised direction TO the sun. Low elevation, strongly side-on. */
  sunDirection: [-0.62, 0.28, 0.73],

  // --- Ambient: sky bounce above, warm ground bounce below ---
  ambientSky: 0x5f8fa8,
  ambientGround: 0x4a3527,
  ambientIntensity: 0.46,

  // --- Water: near-mirror, its colour comes mostly from the sky it reflects ---
  waterDeep: 0x0e2733,
  waterShallow: 0x1f5566,
  waterFoam: 0xe6efe9,
  waterSpecular: 0xfff0d2,

  // --- Terrain: warm sunlit rock, cool shadowed rock, dark cliff faces ---
  rockLit: 0xbb8a60,
  rockShadow: 0x54413c,
  rockCliff: 0x3b2f2c,
  rockHigh: 0xe0b98a,
  sand: 0xccb292,

  // --- Entities ---
  planeBody: 0xdde3e6,
  planeAccent: 0xc9412e,
  hostileBody: 0x6b6f6a,
  hostileAccent: 0x8c3a2a,
  fuelBody: 0x3f7a52,
  bridgeBody: 0x4a4340,

  // --- Effects: the only place fully saturated emissive is allowed ---
  tracer: 0xffd166,
  muzzle: 0xfff2c4,
  explosionCore: 0xfff0c0,
  explosionMid: 0xf58a3c,
  explosionSmoke: 0x4a3a33,
};

/** Atmosphere. Coloured fog, not grey — distance should shift hue, not just fade. */
export const ATMOSPHERE = {
  fogColor: 0xab9a83,
  fogNear: 320,
  fogFar: 1180,
  /** Extra haze that accumulates toward the horizon, on top of linear fog. */
  hazeStrength: 0.55,
};

/** Renderer-level grade. Owned by main.js; nobody else sets these. */
export const GRADE = {
  exposure: 1.15,
  /** Applied in post: 1.0 = untouched. */
  saturation: 1.12,
  contrast: 1.06,
  vignette: 0.28,
};

/**
 * Post-processing intensities. Deliberately restrained: the look is carried by
 * palette and light, and heavy post is how a stylised scene turns to mush.
 */
export const POST = {
  bloomStrength: 0.42,
  bloomRadius: 0.5,
  bloomThreshold: 0.82,
  motionBlurStrength: 0.55,
  dofFocusDistance: 90,
  dofBokehScale: 1.4,
  grain: 0.035,
  chromaticAberration: 0.0018,
};

/** Rough scale reference so modules size effects consistently. */
export const SCALE = {
  planeWingspan: 13,
  riverWidthTypical: 55,
  bankHeight: 15,
  cruiseSpeed: 80,
};

// =============================================================================
// BIOMES — the same box art, painted three times along the river.
//
// A run is a journey, so the palette travels with it. Each biome is a *partial*
// override of PALETTE + ATMOSPHERE: everything it does not name is inherited
// from the amber desert above, which is also biome 0 and the control — its
// override is empty, so sectors 1–2 render exactly as they did before biomes
// existed. Every hue a later biome uses is declared here and nowhere else; the
// rule at the top of this file still holds, it just has three columns now.
//
// The blend band BEGINS at the boundary bridge and runs BIOME_BLEND units into
// the new sector, rather than straddling the bridge. Two reasons. The sector
// table below says sectors 1–2 are amber, and the terrain is painted once per
// streamed chunk and never repainted, so a band centred on the bridge would
// paint the last half-band of sector 2 in the next biome. And the bridge is the
// gate the player has to shoot down: the world changing on the far side of it
// reads as cause and effect. The band is wide (five seconds of flight at cruise)
// because adjacent chunks are painted at different times — the ramp has to be
// shallow enough that a chunk edge never shows as a step in the paint.
// =============================================================================

/**
 * Sector length in world units. Mirrors BRIDGE_SPACING in game/entities.js —
 * the game owns the gates, this only needs to know where they stand.
 */
export const SECTOR_LENGTH = 1000;

/** Width of the blend band, in world units, starting at the boundary bridge. */
export const BIOME_BLEND = 400;

/**
 * How the live rig (lights, fog, water) follows biomeAt(playerZ): exponential
 * rate per second, and the forward jump in a single frame past which the move
 * is a respawn rather than flight, so the rig snaps instead of time-lapsing.
 * The plane never covers more than ~35 units in one frame.
 */
export const BIOME_FOLLOW = { rate: 2.0, teleport: 200 };

/**
 * Sector tables. `startSector` is 1-based, as the HUD counts it. Keys must be
 * ones biomeAt blends (the colour and scalar lists below); anything else —
 * sunDirection in particular — is fixed for the whole run, and a typo here
 * throws at load rather than silently doing nothing.
 */
export const BIOMES = [
  {
    name: 'amber',
    startSector: 1,
    palette: {},
    atmosphere: {},
  },
  {
    // Basalt gorge: dark volcanic rock, cooler shadows, the zenith pulled to
    // teal, deeper greener water, cooler denser fog. The sun is the same sun;
    // the contrast comes from a darker world under it and a weaker fill.
    name: 'basalt',
    startSector: 3,
    palette: {
      skyZenith: 0x1d6f7a,
      skyHorizon: 0xc9a06a,
      skyMid: 0x5c8c85,
      sunIntensity: 3.7,
      ambientSky: 0x3f7c8c,
      ambientGround: 0x2d2c30,
      ambientIntensity: 0.4,
      waterDeep: 0x07201f,
      waterShallow: 0x17504b,
      waterFoam: 0xdfe9e2,
      rockLit: 0x6e6259,
      rockShadow: 0x2b292d,
      rockCliff: 0x1a181b,
      rockHigh: 0x8d8478,
      sand: 0x7f7466,
    },
    atmosphere: {
      fogColor: 0x76878a,
      fogNear: 280,
      fogFar: 1100,
      hazeStrength: 0.52,
    },
  },
  {
    // High cold: pale dust, snow-lit ridges, thinner colder air, a lower paler
    // sun, steel-blue water. The ground bounce stays warm so the highlights
    // still belong to the same world.
    name: 'cold',
    startSector: 5,
    palette: {
      skyZenith: 0x3d74a3,
      skyHorizon: 0xe8cdae,
      skyMid: 0x98adb6,
      sunColor: 0xffe3bf,
      sunIntensity: 3.0,
      ambientSky: 0x8db3c8,
      ambientGround: 0x6e5f52,
      ambientIntensity: 0.54,
      waterDeep: 0x152a3d,
      waterShallow: 0x3d687e,
      waterFoam: 0xf2f5f3,
      waterSpecular: 0xfff8ea,
      rockLit: 0xcdb59b,
      rockShadow: 0x6e6a70,
      rockCliff: 0x4b4549,
      rockHigh: 0xf1ede6,
      sand: 0xdad0bf,
    },
    atmosphere: {
      fogColor: 0xbcc5c8,
      // Thinner air is a clearer near field, not a further horizon: the terrain
      // streams to a fixed distance, so fogFar stays where it hides that edge.
      fogNear: 440,
      fogFar: 1180,
      hazeStrength: 0.42,
    },
  },
];

/** The entries of a blended biome, by type. Everything else is fixed for the run. */
export const BIOME_COLOR_KEYS = [
  'skyZenith', 'skyHorizon', 'skyMid',
  'sunColor',
  'ambientSky', 'ambientGround',
  'waterDeep', 'waterShallow', 'waterFoam', 'waterSpecular',
  'rockLit', 'rockShadow', 'rockCliff', 'rockHigh', 'sand',
  'fogColor',
];
export const BIOME_SCALAR_KEYS = [
  'sunIntensity', 'ambientIntensity', 'fogNear', 'fogFar', 'hazeStrength',
];

function resolveBiome(biome) {
  for (const k of Object.keys(biome.palette).concat(Object.keys(biome.atmosphere))) {
    if (!BIOME_COLOR_KEYS.includes(k) && !BIOME_SCALAR_KEYS.includes(k)) {
      throw new Error(`direction.js: biome '${biome.name}' overrides '${k}', which is not blendable`);
    }
  }
  const src = { ...PALETTE, ...ATMOSPHERE, ...biome.palette, ...biome.atmosphere };
  const out = { name: biome.name, startZ: (biome.startSector - 1) * SECTOR_LENGTH, from: 0, to: 0, t: 1 };
  // Hex -> linear at load, once, with the same conversion every use site does.
  for (const k of BIOME_COLOR_KEYS) out[k] = new THREE.Color(src[k]);
  for (const k of BIOME_SCALAR_KEYS) out[k] = src[k];
  return out;
}

const RESOLVED = BIOMES.map(resolveBiome);
const INV_BLEND = 1 / BIOME_BLEND;

/**
 * The one object biomeAt ever returns. Preallocated, including its Colors, so
 * the per-row call in the terrain paint and the per-frame calls in the light
 * and water rigs allocate nothing.
 */
const BLENDED = resolveBiome(BIOMES[0]);

/**
 * Palette + atmosphere at world z, blended across the band past each bridge.
 *
 * Returns `BLENDED` — THE SAME OBJECT EVERY CALL, its Colors included. Read or
 * copy what you need before calling it again; never keep a reference to it or
 * to one of its Colors expecting the value to stay put. Besides the blended
 * entries it carries `from`, `to` (indices into BIOMES) and `t` (0 = all
 * `from`, 1 = all `to`; pure biomes report from === to and t = 1).
 *
 * Inside a pure biome the entries are copied, not interpolated, so biome 0
 * comes back bit-for-bit as PALETTE and ATMOSPHERE.
 */
export function biomeAt(z) {
  let i = RESOLVED.length - 1;
  while (i > 0 && z < RESOLVED[i].startZ) i--;

  let t = 1;
  if (i > 0) {
    const u = (z - RESOLVED[i].startZ) * INV_BLEND;
    if (u < 1) t = u * u * (3 - 2 * u);
  }

  const to = RESOLVED[i];
  if (t >= 1) {
    for (let k = 0; k < BIOME_COLOR_KEYS.length; k++) {
      const key = BIOME_COLOR_KEYS[k];
      BLENDED[key].copy(to[key]);
    }
    for (let k = 0; k < BIOME_SCALAR_KEYS.length; k++) {
      const key = BIOME_SCALAR_KEYS[k];
      BLENDED[key] = to[key];
    }
    BLENDED.from = i;
    BLENDED.to = i;
    BLENDED.t = 1;
    return BLENDED;
  }

  const from = RESOLVED[i - 1];
  for (let k = 0; k < BIOME_COLOR_KEYS.length; k++) {
    const key = BIOME_COLOR_KEYS[k];
    BLENDED[key].lerpColors(from[key], to[key], t);
  }
  for (let k = 0; k < BIOME_SCALAR_KEYS.length; k++) {
    const key = BIOME_SCALAR_KEYS[k];
    const a = from[key];
    BLENDED[key] = a + (to[key] - a) * t;
  }
  BLENDED.from = i - 1;
  BLENDED.to = i;
  BLENDED.t = t;
  return BLENDED;
}
