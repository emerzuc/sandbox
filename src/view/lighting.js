import * as THREE from 'three';
import { PALETTE, ATMOSPHERE, SCALE } from '../art/direction.js';
import { WATER_Y } from '../world/river.js';

/**
 * One sun, one ambient, one coloured fog. That is the whole rig.
 *
 * The box art gets its drama from a single low raking key and from what it
 * leaves dark, not from a lighting setup — every extra fill light we add is a
 * shadow we delete. So: a directional key at PALETTE.sunDirection casting real
 * shadows, a hemisphere for the sky/ground bounce, and warm fog so distance
 * shifts hue instead of draining to grey.
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

  /**
   * The player travels thousands of units forward, so the shadow box has to
   * travel with them; a fixed world-space one is empty within seconds.
   *
   * It is snapped to whole shadow-map texels in light space before it moves. A
   * box that slides continuously re-rasterises every shadow edge every frame,
   * which reads as the whole landscape shimmering — far more distracting than
   * the aliasing the resolution would otherwise cause.
   *
   * `dt` is accepted but unused: the sun is fixed by art direction, and nothing
   * here has state to integrate. It stays in the signature so this can start
   * animating without every caller changing.
   */
  function update(dt, playerZ, playerX = 0) {
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
