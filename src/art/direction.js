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
 */

/** Hex is authoring-friendly; convert with new THREE.Color(...) at use site. */
export const PALETTE = {
  // --- Sky: the amber-to-turquoise gradient the box art is built on ---
  skyZenith: 0x2c6d8f,
  skyHorizon: 0xe8a04a,
  skyMid: 0x7d9a8d,

  // --- Sun: low and raking, never overhead. Long shadows are the point. ---
  sunColor: 0xffd6a0,
  sunIntensity: 3.2,
  /** Normalised direction TO the sun. Low elevation, strongly side-on. */
  sunDirection: [-0.62, 0.28, 0.73],

  // --- Ambient: sky bounce above, warm ground bounce below ---
  ambientSky: 0x5f8fa8,
  ambientGround: 0x4a3527,
  ambientIntensity: 0.55,

  // --- Water: near-mirror, its colour comes mostly from the sky it reflects ---
  waterDeep: 0x0e2733,
  waterShallow: 0x1f5566,
  waterFoam: 0xe6efe9,
  waterSpecular: 0xfff0d2,

  // --- Terrain: warm sunlit rock, cool shadowed rock, dark cliff faces ---
  rockLit: 0xc98b5a,
  rockShadow: 0x54413c,
  rockCliff: 0x3b2f2c,
  rockHigh: 0xe0b98a,
  sand: 0xd8b184,

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
  fogColor: 0xb4926a,
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
