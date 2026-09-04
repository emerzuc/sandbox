import * as THREE from 'three';
import { mulberry32, hash1 } from '../core/rng.js';
import { clamp, lerp, damp } from '../core/math.js';
import { CHUNK_LEN } from '../world/terrain.js';
import {
  riverCenterX, riverHalfWidth, pickChannelX, islandAt,
  shoreSDF, terrainHeight, WORLD_SEED,
} from '../world/river.js';
import { makeEntityMesh } from '../view/shapes.js';

export const BRIDGE_SPACING = 1000;
const FUEL_SPACING = 700;

/**
 * Collision radius and score per kind. `y` is the nominal altitude; the tank
 * overrides it at spawn with the height of the bank it stands on.
 *
 * `shootable: false` marks a kind the player's guns cannot touch — game.js
 * skips it in the bullet pass. The tank keeps an `r` all the same, for the
 * player-vs-entity sphere, even though a plane over land is already dead.
 */
export const SPEC = {
  ship: { r: 6.0, score: 30, y: 0 },
  heli: { r: 4.6, score: 60, y: 9 },
  jet: { r: 4.4, score: 100, y: 7 },
  tank: { r: 4.5, score: 0, y: 0, shootable: false },
  balloon: { r: 5.4, score: 40, y: 7.5 },
  fuel: { r: 9.0, score: 80, y: 0 },
  bridge: { r: 0, score: 500, y: 7 },
  rock: { r: 0, score: 0, y: 0 },
};

/**
 * DIFFICULTY — one row per sector, indexed by `sector - 1` and clamped at the
 * last row, so the ramp ends rather than running away.
 *
 * The three new threats each demand a different answer, and the table decides
 * how often the player is asked each question:
 *   - a ship or a balloon is shot;
 *   - a jet is sidestepped;
 *   - a tank cannot be shot and cannot be outrun — its shell is *read* and
 *     flown around;
 *   - a heli from sector 2 fires back, so it is shot *before* it finishes its
 *     tell, or dodged when it does.
 *
 * Sector 1 is deliberately gentle because the verification harness flies it
 * with an autopilot that never dodges a shell: tanks are rare, their shells
 * slow, and `lead` under 1 means an early shell is aimed short of where a
 * plane flying straight will be — it hits the player who slows down, and
 * whistles behind the one who does not. Full lead only arrives in sector 4.
 *
 *   density    hostiles per 120-unit chunk (fractional part is a coin flip)
 *   weights    [ship, heli, jet, tank] relative kind weights
 *   jetSpeed   jet closing speed range, units/s (on top of the player's own)
 *   tankFire   seconds between tank shells
 *   tankRange  tank engagement distance, units
 *   tankCone   half-angle (rad) of the cone, centred straight across the
 *              river, inside which the tank will fire
 *   shellSpeed tank shell speed, units/s — slow enough to be seen and avoided
 *   lead       0..1, how much of the player's velocity the gunners lead by
 *   heliBurst  seconds between heli bursts; 0 = helis never fire
 *   balloon    probability of a balloon per chunk at a choke point
 */
export const DIFFICULTY = [
  { density: 0.75, weights: [0.62, 0.30, 0.04, 0.04], jetSpeed: [55, 80], tankFire: 4.5, tankRange: 110, tankCone: 0.60, shellSpeed: 90, lead: 0.55, heliBurst: 0, balloon: 0.10 },
  { density: 1.00, weights: [0.50, 0.30, 0.11, 0.09], jetSpeed: [60, 88], tankFire: 3.6, tankRange: 130, tankCone: 0.75, shellSpeed: 94, lead: 0.72, heliBurst: 3.4, balloon: 0.18 },
  { density: 1.35, weights: [0.40, 0.29, 0.16, 0.15], jetSpeed: [68, 96], tankFire: 3.0, tankRange: 150, tankCone: 0.90, shellSpeed: 98, lead: 0.88, heliBurst: 2.7, balloon: 0.26 },
  { density: 1.70, weights: [0.32, 0.28, 0.21, 0.19], jetSpeed: [76, 106], tankFire: 2.4, tankRange: 170, tankCone: 1.00, shellSpeed: 102, lead: 1.0, heliBurst: 2.2, balloon: 0.34 },
  { density: 2.10, weights: [0.26, 0.27, 0.25, 0.22], jetSpeed: [84, 116], tankFire: 2.0, tankRange: 190, tankCone: 1.10, shellSpeed: 106, lead: 1.0, heliBurst: 1.8, balloon: 0.42 },
  { density: 2.60, weights: [0.20, 0.26, 0.29, 0.25], jetSpeed: [92, 126], tankFire: 1.6, tankRange: 210, tankCone: 1.20, shellSpeed: 110, lead: 1.0, heliBurst: 1.4, balloon: 0.50 },
];

const WEIGHT_KINDS = ['ship', 'heli', 'jet', 'tank'];

/** Row of the table for a 1-based sector (game.sector), clamped at both ends. */
export function difficultyFor(sector) {
  return DIFFICULTY[clamp(sector - 1, 0, DIFFICULTY.length - 1)];
}

function pickKind(weights, roll) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] / total;
    if (roll < acc) return WEIGHT_KINDS[i];
  }
  return WEIGHT_KINDS[0];
}

// Must match river.js: islands live in 460-unit bands and the head sits at
// 18% into the band, reaching full width over the next 10% of it.
const ISLAND_BAND = 460;
const ISLAND_HEAD_AT = 0.18 + 0.1 * 0.5;

// --- Tank ---
// Turret slew rate. A plane passing abreast at 30 units sweeps ~2.7 rad/s, so
// the turret can just keep up; watching it come round is the player's tell.
const TURRET_RATE = 3.0;
const TURRET_ALIGNED = 0.15;
// Muzzle relative to the tank origin: barrel length along the aim, and height.
const TANK_MUZZLE_LEN = 5.6;
const TANK_MUZZLE_Y = 2.9;
// In early sectors every tank within one of these bands takes the same bank,
// so no stretch is ever bracketed from both sides at once.
const TANK_BAND = 240;
const TANK_BRACKET_FROM_SECTOR = 4;

// --- Heli ---
const HELI_TELL = 0.45;
const HELI_BURST_N = 3;
const HELI_BURST_GAP = 0.1;
const HELI_SHOT_SPEED = 150;
const HELI_GUN_Y = -0.9;
const HELI_GUN_Z = -2.6;
const HELI_FIRE_NEAR = 40;
// Floor under every shot of a burst, and the distance the plane closes during
// the tell (~0.45 s at cruise plus the first gap) so the tell only starts when
// the whole burst can still be fired from a fair range.
const HELI_MIN_SHOT_DZ = 70;
const HELI_CLOSE_DURING_TELL = 75;
const HELI_FIRE_FAR = 260;

// --- Balloon ---
const BALLOON_SWAY_X = 1.2;
const BALLOON_SWAY_Y = 0.5;
// Never hang a balloon inside a bridge truss or over a fuel depot: the first
// is invisible until it kills, the second turns refuelling into a collision.
const BALLOON_BRIDGE_CLEAR = 40;
const BALLOON_FUEL_CLEAR = 90;

// Scratch for muzzle flashes: fx.muzzle copies the coordinates, so one
// module-level vector serves every gun in the game with no per-frame allocation.
const _muzzle = new THREE.Vector3();
// Lead solution, written by leadTarget() and read straight after.
let _tx = 0, _ty = 0, _tz = 0;

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
    // Cached named child (heli rotor, tank turret): a tree search per frame
    // is not an allocation, but it is a walk we need not repeat.
    part: null,
    // Gunnery. Shared by tank and heli; zero and inert on everything else.
    cool: 0,
    fireInterval: 0,
    range: 0,
    cone: 0,
    shellSpeed: 0,
    lead: 0,
    flashT: 0,
    // Tank: which bank (-1 left, +1 right), turret yaw, and the hull's fit to
    // the slope it parked on.
    side: 0,
    aim: 0,
    hullYaw: 0,
    pitch: 0,
    roll: 0,
    // Heli burst state machine.
    fireT: 0,
    tellT: 0,
    burstN: 0,
    burstT: 0,
    burstInterval: 0,
    dip: 0,
    // Balloon: the anchor it sways around.
    baseX: x,
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

  // --- Hostiles: everything below reads the sector's row of the table. The
  // sector is 1-based here to match game.sector. ---
  const sector = Math.floor(z0 / BRIDGE_SPACING) + 1;
  const D = difficultyFor(sector);
  const n = Math.floor(D.density) + (rnd() < D.density % 1 ? 1 : 0);

  for (let i = 0; i < n; i++) {
    const z = z0 + rnd() * CHUNK_LEN;
    const kind = pickKind(D.weights, rnd());

    if (kind === 'tank') {
      spawnTank(game, z, sector, D, rnd);
      continue;
    }

    const x = pickChannelX(z, rnd, kind === 'ship' ? 8 : 5);
    if (x === null) continue;

    const e = makeEntity(kind, x, SPEC[kind].y, z);
    if (kind === 'ship') e.vx = (rnd() < 0.5 ? -1 : 1) * lerp(7, 17, rnd());
    if (kind === 'heli') {
      e.vx = lerp(5, 12, rnd());
      e.phase = rnd() * Math.PI * 2;
      e.burstInterval = D.heliBurst;
      e.lead = D.lead;
      e.shellSpeed = HELI_SHOT_SPEED;
      // Stagger the first burst so a pair of helis never fire in unison.
      e.fireT = D.heliBurst * lerp(0.5, 1.2, rnd());
    }
    if (kind === 'jet') e.vz = -lerp(D.jetSpeed[0], D.jetSpeed[1], rnd());
    game.add(e);
  }

  // --- Balloons: hung where the routing already matters — an island split or
  // a narrow gorge — so blocking one lane is a real choice, not a nuisance.
  // Open water gets them at a reduced rate. ---
  spawnBalloon(game, z0, z1, D, rnd);
}

/**
 * The bank rises fifteen units over the sixteen past the waterline: a cliff,
 * not a beach. A tank parked "a few units" up it would be half buried on the
 * uphill side and hanging in air on the other. So the tank walks inland from
 * the water's edge until the slope under it eases, and sits on the crest
 * looking down at the river — which is where River Raid II put them anyway.
 */
function spawnTank(game, z, sector, D, rnd) {
  const bracket = sector >= TANK_BRACKET_FROM_SECTOR;
  const side = bracket
    ? (rnd() < 0.5 ? -1 : 1)
    : (hash1(Math.floor(z / TANK_BAND), WORLD_SEED ^ 0x7a9) < 0.5 ? -1 : 1);

  const cx = riverCenterX(z);
  const hw = riverHalfWidth(z);

  let setback = 4;
  let x = cx + side * (hw + setback);
  for (; setback < 17; setback += 2) {
    x = cx + side * (hw + setback);
    const slope = (terrainHeight(x + 2.5, z) - terrainHeight(x - 2.5, z)) / 5;
    if (Math.abs(slope) < 0.45) break;
  }
  // By construction this is the outer shore, but the SDF is the one truth
  // about land here, so it gets the final say.
  if (shoreSDF(x, z) < 3) return;

  const e = makeEntity('tank', x, terrainHeight(x, z), z);
  e.side = side;
  e.hullYaw = -side * Math.PI / 2; // hull faces straight across the water
  e.aim = e.hullYaw;

  // Fit the hull to the ground: pitch along its facing, roll along the bank.
  const gx = (terrainHeight(x + 2.5, z) - terrainHeight(x - 2.5, z)) / 5;
  const gz = (terrainHeight(x, z + 2.5) - terrainHeight(x, z - 2.5)) / 5;
  const facing = -side;
  e.pitch = -Math.atan(facing * gx);
  e.roll = Math.atan(-facing * gz);

  e.fireInterval = D.tankFire;
  e.range = D.tankRange;
  e.cone = D.tankCone;
  e.shellSpeed = D.shellSpeed;
  e.lead = D.lead;
  // Never fires the instant the player enters the cone: the turret has to
  // come round first, and the cooldown starts part-spent so no two tanks in
  // a chunk share a rhythm.
  e.cool = D.tankFire * lerp(0.15, 0.5, rnd());
  game.add(e);
}

function spawnBalloon(game, z0, z1, D, rnd) {
  // Find the tightest lane in the chunk: an island channel or a narrow gorge.
  let bestZ = z0 + CHUNK_LEN * 0.5;
  let bestW = Infinity;
  for (let i = 0; i < 4; i++) {
    const z = z0 + ((i + 0.5) / 4) * CHUNK_LEN;
    const hw = riverHalfWidth(z);
    const isl = islandAt(z);
    let w = 2 * hw;
    if (isl.amt > 0) {
      const ihw = isl.hw * isl.amt;
      w = Math.min(isl.off - ihw + hw, hw - isl.off - ihw);
    }
    if (w < bestW) { bestW = w; bestZ = z; }
  }
  const tight = bestW < 56;
  if (rnd() >= D.balloon * (tight ? 1 : 0.4)) return;

  const kb = Math.round(bestZ / BRIDGE_SPACING);
  if (kb > 0 && Math.abs(bestZ - kb * BRIDGE_SPACING) < BALLOON_BRIDGE_CLEAR) return;
  const kf = Math.round(bestZ / FUEL_SPACING);
  if (kf > 0 && Math.abs(bestZ - kf * FUEL_SPACING) < BALLOON_FUEL_CLEAR) return;

  const x = pickChannelX(bestZ, rnd, 6);
  if (x === null) return;
  const e = makeEntity('balloon', x, SPEC.balloon.y, bestZ);
  e.baseX = x;
  e.phase = rnd() * Math.PI * 2;
  game.add(e);
}

// ------------------------------------------------------------------ gunnery

/**
 * Where to aim so a shot of `speed` from (mx, my, mz) meets a player who
 * keeps flying as they are now. Two fixed-point passes on the time of flight
 * land within a unit of the true intercept at these speeds. `lead` scales the
 * player's velocity: below 1 the gunner aims short, on purpose.
 */
function leadTarget(mx, my, mz, player, speed, lead) {
  const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
  const vx = player.vx * lead;
  const vz = player.speed * lead;
  let t = Math.hypot(px - mx, py - my, pz - mz) / speed;
  let tx = px + vx * t;
  let tz = pz + vz * t;
  t = Math.hypot(tx - mx, py - my, tz - mz) / speed;
  _tx = px + vx * t;
  _ty = py;
  _tz = pz + vz * t;
}

/** Shoot from (mx, my, mz) at the current lead solution. */
function fireAtLead(game, mx, my, mz, speed) {
  const dx = _tx - mx, dy = _ty - my, dz = _tz - mz;
  const k = speed / Math.max(1e-3, Math.hypot(dx, dy, dz));
  _muzzle.set(mx, my, mz);
  game.fx.muzzle(_muzzle);
  game.hostileFire(mx, my, mz, dx * k, dy * k, dz * k);
}

function stepTank(e, dt, player, game) {
  e.flashT = Math.max(0, e.flashT - dt);
  e.cool = Math.max(0, e.cool - dt);

  const mx = e.pos.x + Math.sin(e.aim) * TANK_MUZZLE_LEN;
  const my = e.pos.y + TANK_MUZZLE_Y;
  const mz = e.pos.z + Math.cos(e.aim) * TANK_MUZZLE_LEN;
  leadTarget(mx, my, mz, player, e.shellSpeed, e.lead);

  // Slew the turret toward the lead point at a limited rate; the wrap keeps
  // it turning the short way round.
  const want = Math.atan2(_tx - e.pos.x, _tz - e.pos.z);
  let d = want - e.aim;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const maxStep = TURRET_RATE * dt;
  e.aim += clamp(d, -maxStep, maxStep);

  if (!game || !game.hostileFire) return;
  if (e.cool > 0) return;

  const dx = player.pos.x - e.pos.x;
  const dz = player.pos.z - e.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > e.range || dist < 1) return;

  // Forward cone, centred straight across the river: the gun engages only
  // once the plane is roughly abreast, which is when a slow shell can be seen
  // coming and still be avoided.
  const cosA = (dx * -e.side) / dist;
  if (cosA < Math.cos(e.cone)) return;
  if (Math.abs(d) > TURRET_ALIGNED) return;

  fireAtLead(game, mx, my, mz, e.shellSpeed);
  e.cool = e.fireInterval;
  e.flashT = 0.18;
}

function stepHeli(e, dt, player, game) {
  // The tell: the sway stops for a beat before the burst. Freezing the phase
  // freezes the whole weave, so the silhouette that was rocking goes still.
  const telling = e.tellT > 0 || e.burstN > 0;
  if (!telling) {
    e.phase += dt * 1.3;
    e.pos.x += Math.cos(e.phase) * e.vx * dt;
    e.pos.y = SPEC.heli.y + Math.sin(e.phase * 0.7) * 0.9;
  }
  e.pos.z -= 9 * dt;
  e.dip = damp(e.dip, telling ? 1 : 0, 10, dt);

  if (e.mesh) {
    if (!e.part) e.part = e.mesh.getObjectByName('rotor');
    if (e.part) e.part.rotation.y += dt * 34;
  }

  if (e.burstInterval <= 0 || !game || !game.hostileFire) return;

  const dz = e.pos.z - player.pos.z;
  if (e.burstN > 0) {
    // The tell plus the burst gaps last most of a second, and the plane closes
    // sixty-odd units in that time. Without a floor, a burst that began at a
    // fair range ends point-blank — 0.08 s to impact, undodgeable by anyone.
    // Past the floor the burst is simply abandoned; the heli reloads.
    if (dz < HELI_MIN_SHOT_DZ) {
      e.burstN = 0;
      e.fireT = e.burstInterval * 0.6;
      return;
    }
    e.burstT -= dt;
    if (e.burstT <= 0) {
      const mx = e.pos.x, my = e.pos.y + HELI_GUN_Y, mz = e.pos.z + HELI_GUN_Z;
      leadTarget(mx, my, mz, player, e.shellSpeed, e.lead);
      fireAtLead(game, mx, my, mz, e.shellSpeed);
      e.burstT = HELI_BURST_GAP;
      e.burstN--;
      if (e.burstN === 0) e.fireT = e.burstInterval;
    }
  } else if (e.tellT > 0) {
    e.tellT -= dt;
    if (e.tellT <= 0) {
      e.burstN = HELI_BURST_N;
      e.burstT = 0;
    }
  } else if (dz > HELI_FIRE_NEAR + HELI_CLOSE_DURING_TELL && dz < HELI_FIRE_FAR) {
    e.fireT -= dt;
    if (e.fireT <= 0) e.tellT = HELI_TELL;
  }
}

export function stepEntity(e, dt, player, game) {
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
    case 'heli':
      stepHeli(e, dt, player, game);
      break;
    case 'jet': {
      e.pos.z += e.vz * dt;
      // Drifts toward the player's lane without ever fully locking on.
      e.pos.x += clamp(player.pos.x - e.pos.x, -12, 12) * dt * 0.8;
      break;
    }
    case 'tank':
      stepTank(e, dt, player, game);
      break;
    case 'balloon': {
      // Slow sway on a tether. Small on purpose: the balloon marks a lane, and
      // a lane that wanders is a hazard the player cannot plan around.
      e.phase += dt * 0.9;
      e.pos.x = e.baseX + Math.sin(e.phase) * BALLOON_SWAY_X;
      e.pos.y = SPEC.balloon.y + Math.sin(e.phase * 0.61 + 1.7) * BALLOON_SWAY_Y;
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
  switch (e.kind) {
    case 'ship':
      e.mesh.rotation.y = e.vx > 0 ? -Math.PI / 2 : Math.PI / 2;
      break;
    case 'bridge':
      e.mesh.scale.x = e.halfWidth * 2;
      break;
    case 'heli':
      // Nose dips as it settles to fire: the second half of the tell.
      e.mesh.rotation.x = -e.dip * 0.16;
      break;
    case 'tank': {
      // Yaw outermost so pitch and roll stay in the hull's own frame.
      e.mesh.rotation.set(e.pitch, e.hullYaw, e.roll, 'YXZ');
      if (!e.part) e.part = e.mesh.getObjectByName('turret');
      if (e.part) {
        e.part.rotation.y = e.aim - e.hullYaw;
        // Recoil: the turret rocks back on its ring for a few frames.
        e.part.position.z = -0.4 - (e.flashT / 0.18) * 0.35;
      }
      break;
    }
    case 'balloon':
      e.mesh.rotation.y = Math.sin(e.phase * 0.5) * 0.12;
      e.mesh.rotation.z = Math.sin(e.phase) * 0.06;
      break;
    default:
      break;
  }
}

export { makeEntity, makeEntityMesh };
