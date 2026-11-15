import * as THREE from 'three';
import { PALETTE, ATMOSPHERE, SCALE, BIOME_FOLLOW, biomeAt } from '../art/direction.js';
import { WATER_Y } from '../world/river.js';
import { setTerrainAtmosphere } from '../world/terrainMaterial.js';
import { lerp } from '../core/math.js';

/**
 * One sun, one ambient, one coloured fog. That is the whole rig.
 *
 * The box art gets its drama from a single low raking key and from what it
 * leaves dark, not from a lighting setup — every extra fill light we add is a
 * shadow we delete. So: a directional key at PALETTE.sunDirection casting real
 * shadows, a hemisphere for the sky/ground bounce, and warm fog so distance
 * shifts hue instead of draining to grey.
 *
 * The rig's colours are not fixed: every frame they ease toward biomeAt(playerZ)
 * (see `update`). The sun's *direction* is — the shadow box's texel-snapping
 * basis and the terrain's baked sun-facing paint both assume it never moves.
 *
 * GRADE (exposure, saturation, contrast) belongs to main.js. This module only
 * touches renderer.shadowMap, which is a property of the light rig, not a grade.
 */

/**
 * 2048². The honest cost, measured rather than guessed: a 2048×2048 depth target
 * (~16 MB) plus one depth-only pass over every caster inside the box each frame.
 * With the terrain casting that is one extra draw call per visible chunk — about
 * ten — and it roughly doubles the triangles submitted. The game runs ~70 draws
 * against a budget of 150, so it fits with room for the entities to cast too.
 *
 * 4096² was tempting and is not worth it: at the box extent below, 2048 already
 * gives ~0.37 world units per texel, a third of a wingspan, and the look wants
 * long soft-edged shadow shapes rather than crisp contact detail. 1024 visibly
 * stair-steps the ridge shadows as the plane moves.
 */
const SHADOW_MAP = 2048;

/**
 * Half-extent of the ortho shadow box, and how far ahead of the player it sits.
 * Together they cover z ∈ [player − 140, player + 620]. Beyond that the linear
 * fog is already past 35 %, so the edge of the shadowed region is buried in
 * haze rather than announcing itself as a line across the valley.
 */
const SHADOW_EXTENT = 380;
const SHADOW_LEAD = 240;

/** Distance the light sits back along the sun direction from the focus point. */
const SUN_DISTANCE = 900;

const TEXEL = (SHADOW_EXTENT * 2) / SHADOW_MAP;

export function setupLighting(scene, renderer) {
  renderer.shadowMap.enabled = true;
  // PCFShadowMap, not PCFSoftShadowMap — the latter is deprecated in r185 and
  // silently downgrades to this anyway. In r185 PCF is a 5-tap Vogel disk on a
  // hardware comparison sampler, dithered per pixel, so `shadow.radius` below is
  // the softness dial and there is nothing left for PCFSoft to add.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Coloured fog and a matching horizon. Anything drawing an actual sky dome
  // later should overwrite scene.background; the fog colour is the right value
  // to fall back to, because it is what every distant object converges to.
  scene.fog = new THREE.Fog(new THREE.Color(ATMOSPHERE.fogColor), ATMOSPHERE.fogNear, ATMOSPHERE.fogFar);
  scene.background = new THREE.Color(ATMOSPHERE.fogColor);

  const dir = new THREE.Vector3(...PALETTE.sunDirection).normalize();

  const sun = new THREE.DirectionalLight(PALETTE.sunColor, PALETTE.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);

  const cam = sun.shadow.camera;
  cam.left = -SHADOW_EXTENT;
  cam.right = SHADOW_EXTENT;
  cam.top = SHADOW_EXTENT;
  cam.bottom = -SHADOW_EXTENT;
  cam.near = 10;
  cam.far = SUN_DISTANCE + SHADOW_EXTENT * 2;
  cam.updateProjectionMatrix();

  // A ~16° sun grazes the terrain, which is the worst case for shadow acne:
  // depth slope is enormous across a near-parallel face.
  //
  // The surprise is which dial fixes it. Raising bias and normalBias barely
  // helped; `radius` was doing the damage. r185's PCF spreads five taps over
  // `radius` texels, and on a grazing face those taps land far enough along the
  // surface to fall behind it, so the ridge crests came out stippled with the
  // sampler's own dither pattern. Dropping radius to 1.5 texels (~0.6 world
  // units of penumbra) cleared it and still softens the edge enough that the
  // shadows do not crawl as the box slides. Verified against a rendered frame,
  // not assumed.
  sun.shadow.radius = 1.5;
  sun.shadow.normalBias = TEXEL * 4;
  sun.shadow.bias = -0.0009;

  scene.add(sun);
  scene.add(sun.target);

  const ambient = new THREE.HemisphereLight(
    PALETTE.ambientSky,
    PALETTE.ambientGround,
    PALETTE.ambientIntensity
  );
  scene.add(ambient);

  // Light-space basis, matching how three builds the shadow camera's view
  // matrix. The sun never moves, so this is computed once and reused to snap
  // the shadow box to whole texels.
  const zAxis = dir.clone();
  const xAxis = new THREE.Vector3(0, 1, 0).cross(zAxis).normalize();
  const yAxis = zAxis.clone().cross(xAxis).normalize();

  const focus = new THREE.Vector3();
  const anchor = new THREE.Vector3();

  const fog = scene.fog;
  const background = scene.background;
  // The terrain's aerial haze has no light object to live on; it is damped here
  // alongside the fog it sits on top of, and pushed to the terrain material.
  let haze = ATMOSPHERE.hazeStrength;
  let lastZ = NaN;

  /**
   * The player travels thousands of units forward, so the shadow box has to
   * travel with them; a fixed world-space one is empty within seconds.
   *
   * It is snapped to whole shadow-map texels in light space before it moves. A
   * box that slides continuously re-rasterises every shadow edge every frame,
   * which reads as the whole landscape shimmering — far more distracting than
   * the aliasing the resolution would otherwise cause.
   *
   * The rig's colours, intensities and fog range ease toward biomeAt(playerZ)
   * with the same frame-rate-independent damping the camera uses. `dt` only
   * matters for that easing; the sun's direction is fixed by art direction. The
   * band itself is already 400 units of smoothstep, so the easing is not doing
   * the blend — it is there so a respawn does not cut and a hitch does not
   * step. A jump longer than a frame of flight can cover is a respawn, and
   * snaps: easing across a teleport would play a two-second time-lapse.
   *
   * Inside a pure biome the targets equal the current values exactly, so the
   * lerps are no-ops to the bit and sectors 1–2 render as they always did.
   */
  function update(dt, playerZ, playerX = 0) {
    const b = biomeAt(playerZ);
    // `!(<= teleport)` rather than `>` so the NaN of the first call snaps too.
    const snap = !(Math.abs(playerZ - lastZ) <= BIOME_FOLLOW.teleport);
    lastZ = playerZ;

    if (snap) {
      sun.color.copy(b.sunColor);
      sun.intensity = b.sunIntensity;
      ambient.color.copy(b.ambientSky);
      ambient.groundColor.copy(b.ambientGround);
      ambient.intensity = b.ambientIntensity;
      fog.color.copy(b.fogColor);
      fog.near = b.fogNear;
      fog.far = b.fogFar;
      haze = b.hazeStrength;
    } else {
      // damp() from core/math, with the coefficient hoisted so the Colors can
      // share it: lerp(cur, target, 1 - e^(-rate·dt)).
      const k = 1 - Math.exp(-BIOME_FOLLOW.rate * dt);
      sun.color.lerp(b.sunColor, k);
      sun.intensity = lerp(sun.intensity, b.sunIntensity, k);
      ambient.color.lerp(b.ambientSky, k);
      ambient.groundColor.lerp(b.ambientGround, k);
      ambient.intensity = lerp(ambient.intensity, b.ambientIntensity, k);
      fog.color.lerp(b.fogColor, k);
      fog.near = lerp(fog.near, b.fogNear, k);
      fog.far = lerp(fog.far, b.fogFar, k);
      haze = lerp(haze, b.hazeStrength, k);
    }
    background.copy(fog.color);
    setTerrainAtmosphere(fog.color, fog.near, fog.far, haze, ambient.groundColor);

    focus.set(playerX, WATER_Y + SCALE.bankHeight * 0.4, playerZ + SHADOW_LEAD);

    const fx = Math.round(focus.dot(xAxis) / TEXEL) * TEXEL;
    const fy = Math.round(focus.dot(yAxis) / TEXEL) * TEXEL;
    const fz = focus.dot(zAxis);

    anchor
      .set(0, 0, 0)
      .addScaledVector(xAxis, fx)
      .addScaledVector(yAxis, fy)
      .addScaledVector(zAxis, fz);

    sun.target.position.copy(anchor);
    sun.position.copy(anchor).addScaledVector(dir, SUN_DISTANCE);
  }

  update(0, 0, 0);

  return { sun, ambient, update };
}
