import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';
import { clamp, lerp } from '../core/math.js';
import { CHUNK_LEN } from '../world/terrain.js';
import { riverCenterX, riverHalfWidth, pickChannelX, islandAt } from '../world/river.js';
import { makeEntityMesh } from '../view/shapes.js';

export const BRIDGE_SPACING = 1000;
const FUEL_SPACING = 700;

/** Collision radius and score per kind. */
export const SPEC = {
  ship: { r: 6.0, score: 30, y: 0 },
  heli: { r: 4.6, score: 60, y: 9 },
  jet: { r: 4.4, score: 100, y: 7 },
  fuel: { r: 9.0, score: 80, y: 0 },
  bridge: { r: 0, score: 500, y: 7 },
  rock: { r: 0, score: 0, y: 0 },
};

// Must match river.js: islands live in 460-unit bands and the head sits at
// 18% into the band, reaching full width over the next 10% of it.
const ISLAND_BAND = 460;
const ISLAND_HEAD_AT = 0.18 + 0.1 * 0.5;

function makeEntity(kind, x, y, z) {
  return {
    kind,
    pos: new THREE.Vector3(x, y, z),
    prevPos: new THREE.Vector3(x, y, z),
    vx: 0,
    vz: 0,
    r: SPEC[kind].r,
    alive: true,
    phase: 0,
    halfWidth: 0,
    mesh: null,
  };
}

/**
 * Populate one chunk. Seeded by chunk index alone, so the contents of any
 * stretch of river are identical on every run and on every replay.
 */
export function spawnChunk(game, ci) {
  const z0 = ci * CHUNK_LEN;
  const z1 = z0 + CHUNK_LEN;
  if (z1 <= 0) return;

  const rnd = mulberry32((Math.imul(ci, 2654435761) ^ 0xc0ffee) >>> 0);

  // --- Bridges: hard section gates. One per BRIDGE_SPACING, must be shot. ---
  for (let k = Math.ceil(z0 / BRIDGE_SPACING); k * BRIDGE_SPACING < z1; k++) {
    if (k <= 0) continue;
    if (game.bridgesDown.has(k)) continue;
    const bz = k * BRIDGE_SPACING;
    const e = makeEntity('bridge', riverCenterX(bz), SPEC.bridge.y, bz);
    e.halfWidth = riverHalfWidth(bz) + 26;
    e.sector = k;
    game.add(e);
  }

  // --- Fuel: placed on a fixed cadence, never left to the dice. Starving the
  // player of fuel by bad luck is not difficulty, it is a bug. ---
  for (let k = Math.ceil(z0 / FUEL_SPACING); k * FUEL_SPACING < z1; k++) {
    if (k <= 0) continue;
    const fz = k * FUEL_SPACING + (rnd() - 0.5) * 120;
    const fx = pickChannelX(fz, rnd, 7);
    if (fx === null) continue;
    game.add(makeEntity('fuel', fx, SPEC.fuel.y, fz));
  }

  // --- Island prows: one tall rock at the head of every island, so the split
  // is announced from a distance instead of discovered underfoot. Scenery
  // only — the land it stands on is what kills. ---
  for (let b = Math.floor(z0 / ISLAND_BAND); b * ISLAND_BAND < z1; b++) {
    const hz = (b + ISLAND_HEAD_AT) * ISLAND_BAND;
    if (hz < z0 || hz >= z1) continue;
    const isl = islandAt(hz);
    if (isl.amt <= 0) continue;
    game.add(makeEntity('rock', riverCenterX(hz) + isl.off, SPEC.rock.y, hz));
  }

  // --- Hostiles: density ramps with the sector. ---
  const sector = Math.max(0, Math.floor(z0 / BRIDGE_SPACING));
  const density = clamp(0.75 + sector * 0.2, 0, 3.0);
  const n = Math.floor(density) + (rnd() < density % 1 ? 1 : 0);

  for (let i = 0; i < n; i++) {
    const z = z0 + rnd() * CHUNK_LEN;
    const roll = rnd();
    const jetGate = clamp(0.1 + sector * 0.05, 0, 0.4);
    const kind = roll < jetGate ? 'jet' : roll < jetGate + 0.35 ? 'heli' : 'ship';

    const x = pickChannelX(z, rnd, kind === 'ship' ? 8 : 5);
    if (x === null) continue;

    const e = makeEntity(kind, x, SPEC[kind].y, z);
    if (kind === 'ship') e.vx = (rnd() < 0.5 ? -1 : 1) * lerp(7, 17, rnd());
    if (kind === 'heli') { e.vx = lerp(5, 12, rnd()); e.phase = rnd() * Math.PI * 2; }
    if (kind === 'jet') e.vz = -lerp(55, 85, rnd());
    game.add(e);
  }
}

export function stepEntity(e, dt, player) {
  e.prevPos.copy(e.pos);

  switch (e.kind) {
    case 'ship': {
      e.pos.x += e.vx * dt;
      const cx = riverCenterX(e.pos.z);
      const hw = riverHalfWidth(e.pos.z) - 8;
      if (e.pos.x < cx - hw) { e.pos.x = cx - hw; e.vx = Math.abs(e.vx); }
      if (e.pos.x > cx + hw) { e.pos.x = cx + hw; e.vx = -Math.abs(e.vx); }
      break;
    }
    case 'heli': {
      e.phase += dt * 1.3;
      e.pos.x += Math.cos(e.phase) * e.vx * dt;
      e.pos.z -= 9 * dt;
      e.pos.y = SPEC.heli.y + Math.sin(e.phase * 0.7) * 0.9;
      if (e.mesh) e.mesh.getObjectByName('rotor').rotation.y += dt * 34;
      break;
    }
    case 'jet': {
      e.pos.z += e.vz * dt;
      // Drifts toward the player's lane without ever fully locking on.
      e.pos.x += clamp(player.pos.x - e.pos.x, -12, 12) * dt * 0.8;
      break;
    }
    default:
      break;
  }
}

/** Render transform for an entity, given the sim interpolation factor. */
export function syncEntityMesh(e, alpha) {
  if (!e.mesh) return;
  e.mesh.position.lerpVectors(e.prevPos, e.pos, alpha);
  if (e.kind === 'ship') e.mesh.rotation.y = e.vx > 0 ? -Math.PI / 2 : Math.PI / 2;
  if (e.kind === 'bridge') e.mesh.scale.x = e.halfWidth * 2;
}

export { makeEntity, makeEntityMesh };
