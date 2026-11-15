import * as THREE from 'three';
import { mulberry32, hash1 } from '../core/rng.js';
import { clamp, lerp, damp } from '../core/math.js';
import { CHUNK_LEN } from '../world/terrain.js';
import {
  riverCenterX, riverHalfWidth, pickChannelX, islandAt,
  shoreSDF, WORLD_SEED, GATE_SPACING, doubleChannel,
} from '../world/river.js';
import { makeEntityMesh } from '../view/shapes.js';

export const BRIDGE_SPACING = GATE_SPACING;
const FUEL_SPACING = 700;

/**
 * The depot is the original's: four long tanks in a row down the river,
 * lettered F-U-E-L, red and white. Long on purpose — the old single tank gave
 * a third of a second of refuelling at cruise, which is a pickup, not a
 * decision. Forty-four units is over half a second at cruise and nearly a full
 * second throttled back, so slowing down to drink is a real choice again.
 * Segment 0 is the near end (the L): a shot takes the nearest letter first.
 */
export const FUEL_SEGS = 4;
export const FUEL_SEG_LEN = 11;
export const FUEL_HALF_W = 5;
export const FUEL_HALF_LEN = (FUEL_SEGS * FUEL_SEG_LEN) / 2;
// Nothing hostile is placed this close, up- or downstream, to a depot in its
// chunk: a depot that dies to the crossfire aimed at its neighbour is not a
// choice the player made.
const FUEL_CLEAR = 70;
// A depot under a bridge cannot be flown over and cannot be spared by anyone
// shooting the bridge; keep it this far short of the gate.
const FUEL_BRIDGE_CLEAR = 150;

/** Stretch of river left empty of hostiles at a (re)start — see game.clearUntil. */
export const RUNWAY = 350;

/**
 * Collision radius and score per kind. `y` is the nominal altitude. `hitY`
 * lifts the centre of the bullet-hit sphere above the origin, for things whose
 * origin sits at their feet.
 *
 * The tank is a shore battery dug in at the waterline. It used to sit on the
 * crest of the bank, out of reach of every gun the player had — a threat with
 * no answer, which the playtest called out. It is worth the most of any
 * regular target because it needs the angled shot and a deliberate swing
 * toward the bank it is on.
 *
 * `fuel.score` is per letter; game.js handles the depot's segments itself.
 */
export const SPEC = {
  ship: { r: 6.0, score: 30, y: 0 },
  heli: { r: 4.6, score: 60, y: 9 },
  jet: { r: 4.4, score: 100, y: 7 },
  tank: { r: 4.5, score: 150, y: 1.6, hitY: 2.6 },
  balloon: { r: 5.4, score: 40, y: 7.5 },
  fuel: { r: 0, score: 20, y: 0 },
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
 * The curve was halved after the second playtest ("muitos inimigos logo de
 * cara") and now introduces one idea per sector instead of all of them at
 * once: sector 1 is ships and helicopters that do not fire — things to shoot,
 * nothing that shoots back; sector 2 adds jets and balloons; the shore battery
 * and returning fire only arrive in sector 3, by which time the angled shot
 * has had two sectors to be discovered. `lead` under 1 means a shell is aimed
 * short of where a plane flying straight will be; full lead arrives in 5.
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
  { density: 0.35, weights: [0.70, 0.30, 0.00, 0.00], jetSpeed: [55, 80], tankFire: 4.5, tankRange: 110, tankCone: 0.60, shellSpeed: 90, lead: 0.55, heliBurst: 0, balloon: 0 },
  { density: 0.55, weights: [0.55, 0.27, 0.18, 0.00], jetSpeed: [55, 80], tankFire: 4.5, tankRange: 110, tankCone: 0.60, shellSpeed: 90, lead: 0.55, heliBurst: 0, balloon: 0.15 },
  { density: 0.80, weights: [0.42, 0.28, 0.16, 0.14], jetSpeed: [60, 88], tankFire: 4.0, tankRange: 130, tankCone: 0.75, shellSpeed: 92, lead: 0.70, heliBurst: 3.2, balloon: 0.22 },
  { density: 1.10, weights: [0.34, 0.28, 0.20, 0.18], jetSpeed: [68, 96], tankFire: 3.2, tankRange: 150, tankCone: 0.90, shellSpeed: 96, lead: 0.85, heliBurst: 2.6, balloon: 0.30 },
  { density: 1.50, weights: [0.28, 0.27, 0.24, 0.21], jetSpeed: [76, 106], tankFire: 2.6, tankRange: 170, tankCone: 1.00, shellSpeed: 100, lead: 1.0, heliBurst: 2.1, balloon: 0.38 },
  { density: 2.00, weights: [0.22, 0.26, 0.28, 0.24], jetSpeed: [84, 116], tankFire: 2.1, tankRange: 190, tankCone: 1.10, shellSpeed: 104, lead: 1.0, heliBurst: 1.7, balloon: 0.45 },
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

// The prow rock stands this far past the start of a double channel, where the
// strip of land has reached about half its width.
const PROW_ROCK_AT = 15;
// Inside a double channel hostiles keep to the middle of their chunk, so two
// in the same arm from neighbouring chunks are never nose to tail — the
// "narrow channel, and two of them in it" the playtest objected to.
const ARM_Z_INSET = 0.2;

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
const TANK_BRACKET_FROM_SECTOR = 5;
// How far up the bank the battery is dug in. Close enough to the water that a
// shot fired on the diagonal reaches it before it reaches the cliff behind.
const TANK_SETBACK = 3.5;
// Moving the battery down to the water also moved it sixteen units closer to
// its target, and beside an island the lane is narrow enough that a plane is
// never more than twenty units from the bank. The autopilot died seven times
// running to one such gun: a shell with 0.15 s to impact is not a hazard, it
// is a wall. So: no battery beside an island, and no shot at a plane this
// close — a shell must have at least half a second of flight to be read.
const TANK_ISLAND_CLEAR = 60;
const TANK_MIN_RANGE = 55;

// A ship is twelve units long and sails beam-on to the bank it is heading for.
const SHIP_MARGIN = 8;
// Aircraft keep this far from the banks of their own arm.
const AIR_MARGIN = 5;

// Written by armBounds(): the water an entity at (x, z) has to itself — the
// whole river, or one arm of it when a strip of land runs down the middle.
let _lo = 0, _hi = 0;
function armBounds(x, z) {
  const cx = riverCenterX(z);
  const hw = riverHalfWidth(z);
  _lo = cx - hw;
  _hi = cx + hw;
  const isl = islandAt(z);
  if (isl.amt > 0) {
    const icx = cx + isl.off;
    const ihw = isl.hw * isl.amt;
    if (x < icx) _hi = icx - ihw; else _lo = icx + ihw;
  }
}

// --- Heli ---
const HELI_TELL = 0.45;
const HELI_BURST_N = 3;
const HELI_BURST_GAP = 0.1;
const HELI_SHOT_SPEED = 150;
const HELI_GUN_Y = -0.9;
const HELI_GUN_Z = -2.6;
const HELI_FIRE_NEAR = 130;
// Floor under every shot of a burst, and the distance the plane closes during
// the tell (~0.45 s at cruise plus the first gap) so the tell only starts when
// the whole burst can still be fired from a fair range.
// Both floors are really a time: shot and plane close at ~210 units/s, so 130
// units is about 0.6 s to impact. The first floor was 70 — a third of a
// second, under human reaction time — and the harness died four times running
// to one sector-6 helicopter before it was raised.
const HELI_MIN_SHOT_DZ = 130;
const HELI_CLOSE_DURING_TELL = 75;
const HELI_FIRE_FAR = 340;

// --- Balloon ---
const BALLOON_SWAY_X = 1.2;
const BALLOON_SWAY_Y = 0.5;
// Never hang a balloon inside a bridge truss or over a fuel depot: the first
// is invisible until it kills, the second turns refuelling into a collision.
const BALLOON_BRIDGE_CLEAR = 40;
const BALLOON_FUEL_CLEAR = 90;
// A balloon closes an arm; with a hostile right beside it that is a pair.
const BALLOON_HOSTILE_CLEAR = 70;

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
    // Fuel depot: letters still standing, and the grace period after one goes.
    segs: 0,
    shield: 0,
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
  // A depot belongs to the chunk its centre falls in, wherever its index says
  // it nominally is — the jitter can carry it across a chunk boundary.
  for (let k = Math.max(1, Math.floor(z0 / FUEL_SPACING)); (k - 1) * FUEL_SPACING < z1; k++) {
    const fz = depotZ(k);
    if (fz < z0 || fz >= z1) continue;
    const fx = placeDepot(fz, rnd);
    if (fx === null) continue;
    const e = makeEntity('fuel', fx, SPEC.fuel.y, fz);
    e.segs = FUEL_SEGS;
    game.add(e);
  }
  // Empty water at a start and after every death: the first thing a new plane
  // meets must not be a helicopter already in its face.
  const clearUntil = game.clearUntil ?? -Infinity;
  const blocked = (z) => z < clearUntil || nearDepot(z);

  // --- Island prows: one tall rock at the head of every island, so the split
  // is announced from a distance instead of discovered underfoot. Scenery
  // only — the land it stands on is what kills. ---
  const stretch = doubleChannel(Math.floor(z0 / BRIDGE_SPACING));
  if (stretch) {
    const hz = stretch.from + PROW_ROCK_AT;
    if (hz >= z0 && hz < z1) {
      game.add(makeEntity('rock', riverCenterX(hz) + islandAt(hz).off, SPEC.rock.y, hz));
    }
  }

  // --- Hostiles: everything below reads the sector's row of the table. The
  // sector is 1-based here to match game.sector. ---
  const sector = Math.floor(z0 / BRIDGE_SPACING) + 1;
  const D = difficultyFor(sector);
  // Error diffusion instead of a coin flip per chunk. The same average, but
  // evenly paced: a coin flip at these densities produced long empty runs
  // followed by clumps, and a clump is exactly the "too many at once" the
  // playtest objected to. The die is still rolled so the stream stays aligned.
  rnd();
  const n = Math.floor(D.density * (ci + 1) + 0.5) - Math.floor(D.density * ci + 0.5);

  const placed = [];
  for (let i = 0; i < n; i++) {
    let z = z0 + rnd() * CHUNK_LEN;
    let kind = pickKind(D.weights, rnd());
    // In a double channel: one hostile per arm per chunk, alternating arms
    // from chunk to chunk, and kept off the chunk's ends.
    const split = islandAt(z).amt > 0;
    if (split) z = z0 + CHUNK_LEN * (ARM_Z_INSET + (1 - 2 * ARM_Z_INSET) * ((z - z0) / CHUNK_LEN));
    const arm = split ? (ci + i) & 1 : -1;
    // The dice are rolled either way, so clearing a stretch does not reshuffle
    // everything downstream of it.
    if (blocked(z)) continue;

    if (kind === 'tank') {
      if (spawnTank(game, z, sector, D, rnd)) { placed.push(z); continue; }
      // No room for a battery here (it does not stand beside a double
      // channel). The slot is not wasted: something that flies or floats
      // takes it, so the sector keeps the density its row asks for.
      kind = pickKind([D.weights[0], D.weights[1], D.weights[2], 0], rnd());
    }

    const x = pickChannelX(z, rnd, kind === 'ship' ? 8 : 5, arm);
    if (x === null) continue;
    placed.push(z);

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
  spawnBalloon(game, z0, z1, D, rnd, (z) => blocked(z) || placed.some((pz) => Math.abs(pz - z) < BALLOON_HOSTILE_CLEAR));
}

/**
 * Where depot k sits along the river. A pure function of k — not of any
 * chunk's dice — so the clearance around a depot can be honoured by the
 * chunks either side of it, which never see it spawn.
 */
function depotZ(k) {
  let fz = k * FUEL_SPACING + (hash1(k, WORLD_SEED ^ 0xf0e1) - 0.5) * 120;
  const kb = Math.round(fz / BRIDGE_SPACING);
  if (kb > 0 && Math.abs(fz - kb * BRIDGE_SPACING) < FUEL_BRIDGE_CLEAR) {
    fz = kb * BRIDGE_SPACING - FUEL_BRIDGE_CLEAR;
  }
  return fz;
}

function nearDepot(z) {
  const k = Math.round(z / FUEL_SPACING);
  for (let j = Math.max(1, k - 1); j <= k + 1; j++) {
    if (Math.abs(z - depotZ(j)) < FUEL_CLEAR) return true;
  }
  return false;
}

/**
 * A depot is 44 units of river long, so one x has to be over water — with room
 * for a wing either side — along its whole length, bends and island noses
 * included. A few tries with the chunk's own dice, then give up on this one.
 */
function placeDepot(fz, rnd) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const x = pickChannelX(fz, rnd, 10);
    if (x === null) continue;
    let clear = true;
    for (let k = -1; k <= 1 && clear; k++) {
      const z = fz + k * FUEL_HALF_LEN;
      if (shoreSDF(x - FUEL_HALF_W - 5, z) > -1 || shoreSDF(x + FUEL_HALF_W + 5, z) > -1) clear = false;
    }
    if (clear) return x;
  }
  return null;
}

/**
 * Shore battery, dug in at the waterline on a concrete footing.
 *
 * It began life on the crest of the bank — the slope is a cliff, and a hull
 * parked on it is half buried — but up there it was fifteen units above every
 * gun in the game. Down here the angled shot reaches it, and the footing in
 * the model is what makes a level gun on a steep bank look built rather than
 * misplaced.
 */
function spawnTank(game, z, sector, D, rnd) {
  const bracket = sector >= TANK_BRACKET_FROM_SECTOR;
  const side = bracket
    ? (rnd() < 0.5 ? -1 : 1)
    : (hash1(Math.floor(z / TANK_BAND), WORLD_SEED ^ 0x7a9) < 0.5 ? -1 : 1);

  for (let d = -TANK_ISLAND_CLEAR; d <= TANK_ISLAND_CLEAR; d += 20) {
    if (islandAt(z + d).amt > 0) return false;
  }
  const x = riverCenterX(z) + side * (riverHalfWidth(z) + TANK_SETBACK);
  // By construction this is the outer shore, but the SDF is the one truth
  // about land here, so it gets the final say.
  const sd = shoreSDF(x, z);
  if (sd < 2 || sd > 6) return false;

  const e = makeEntity('tank', x, SPEC.tank.y, z);
  e.side = side;
  e.hullYaw = -side * Math.PI / 2; // hull faces straight across the water
  e.aim = e.hullYaw;

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
  return true;
}

function spawnBalloon(game, z0, z1, D, rnd, blocked) {
  // Find the tightest lane in the chunk: an island channel or a narrow gorge.
  let bestZ = z0 + CHUNK_LEN * 0.5;
  let bestW = Infinity;
  const inSplit = islandAt(z0 + CHUNK_LEN * 0.5).amt > 0;
  for (let i = inSplit ? 1 : 0; i < (inSplit ? 3 : 4); i++) {
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
  if (x === null || blocked(bestZ)) return;
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
  if (dist > e.range || dist < TANK_MIN_RANGE) return;

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
    armBounds(e.prevPos.x, e.pos.z);
    e.pos.x = clamp(e.pos.x, _lo + AIR_MARGIN, Math.max(_lo + AIR_MARGIN, _hi - AIR_MARGIN));
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
      // Patrol the channel it was launched in. It used to turn at the outer
      // banks only, and so sailed straight through any island in between.
      armBounds(e.pos.x, e.pos.z);
      const lo = _lo + SHIP_MARGIN;
      const hi = _hi - SHIP_MARGIN;
      if (hi <= lo) {
        // No room to patrol: hold station mid-channel.
        e.pos.x = (lo + hi) / 2;
        break;
      }
      e.pos.x += e.vx * dt;
      if (e.pos.x < lo) { e.pos.x = lo; e.vx = Math.abs(e.vx); }
      if (e.pos.x > hi) { e.pos.x = hi; e.vx = -Math.abs(e.vx); }
      break;
    }
    case 'fuel':
      e.shield = Math.max(0, e.shield - dt);
      break;
    case 'heli':
      stepHeli(e, dt, player, game);
      break;
    case 'jet': {
      e.pos.z += e.vz * dt;
      // Drifts toward the player's lane without ever fully locking on — but
      // stays in its own arm of a double channel rather than cutting across
      // the land between.
      e.pos.x += clamp(player.pos.x - e.pos.x, -12, 12) * dt * 0.8;
      armBounds(e.prevPos.x, e.pos.z);
      e.pos.x = clamp(e.pos.x, _lo + AIR_MARGIN, Math.max(_lo + AIR_MARGIN, _hi - AIR_MARGIN));
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
    case 'fuel':
      // Children are seg0..seg3, near end first; the spent ones are gone.
      for (let i = 0; i < FUEL_SEGS; i++) e.mesh.children[i].visible = i >= FUEL_SEGS - e.segs;
      break;
    case 'balloon':
      e.mesh.rotation.y = Math.sin(e.phase * 0.5) * 0.12;
      e.mesh.rotation.z = Math.sin(e.phase) * 0.06;
      break;
    default:
      break;
  }
}

export { makeEntity, makeEntityMesh };
