import * as THREE from 'three';
import { Game, FUEL_MAX } from '../src/game/game.js';
import { spawnChunk, stepEntity, makeEntity, SPEC, RUNWAY, BRIDGE_SPACING, FUEL_HALF_LEN, FUEL_HALF_W } from '../src/game/entities.js';
import { pickChannelX, doubleChannel } from '../src/world/river.js';
import { mulberry32 } from '../src/core/rng.js';
import { shoreSDF, riverCenterX, riverHalfWidth, islandAt } from '../src/world/river.js';
import { CHUNK_LEN } from '../src/world/terrain.js';

/**
 * Simulation gate. Pure Node, no browser, no pixels: the world and the rules
 * are plain functions and a fixed-step sim, so the things the second playtest
 * complained about — ships inside islands, a helicopter in your face at the
 * start, too much too soon, batteries with no answer, depots that die by
 * accident — can each be pinned down as an assertion and kept that way.
 */
const DT = 1 / 120;
const HOSTILE = new Set(['ship', 'heli', 'jet', 'tank', 'balloon']);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const input = (o = {}) => ({
  lateral: 0, throttle: 0, firing: false, firingAlt: false, autoFire: false,
  consumeFire: () => false, consumeFireAlt: () => false, consumeRestart: () => false, ...o,
});

// ------------------------------------------------------------------- world
const world = { bridgesDown: new Set(), clearUntil: RUNWAY, ents: [], add(e) { this.ents.push(e); } };
const LAST_CHUNK = Math.ceil(6500 / CHUNK_LEN);
for (let ci = -1; ci <= LAST_CHUNK; ci++) spawnChunk(world, ci);
const hostiles = world.ents.filter((e) => HOSTILE.has(e.kind));
const sectorOf = (e) => Math.floor(e.pos.z / BRIDGE_SPACING) + 1;

check('runway: no hostile in the first 350 units',
  hostiles.every((e) => e.pos.z >= RUNWAY), `nearest at z=${Math.min(...hostiles.map((e) => e.pos.z)).toFixed(0)}`);

const s1 = hostiles.filter((e) => sectorOf(e) === 1);
check('sector 1 is ships and helicopters only', s1.every((e) => e.kind === 'ship' || e.kind === 'heli'),
  [...new Set(s1.map((e) => e.kind))].join(', '));
check('nothing shoots back before sector 3',
  hostiles.filter((e) => sectorOf(e) <= 2).every((e) => e.kind !== 'tank' && !(e.kind === 'heli' && e.burstInterval > 0)));

const perSector = [1, 2, 3, 4, 5, 6].map((s) => hostiles.filter((e) => sectorOf(e) === s).length);
check('the curve climbs, and starts gently', perSector[0] <= 5 && perSector[5] > perSector[0] * 3 && perSector[5] <= 24,
  `hostiles per sector: ${perSector.join(' ')}`);

const tanks = hostiles.filter((e) => e.kind === 'tank');
check('batteries are dug in at the waterline', tanks.length >= 3 && tanks.every((e) => {
  const sd = shoreSDF(e.pos.x, e.pos.z); return sd >= 2 && sd <= 6;
}), `${tanks.length} batteries`);

check('no battery stands beside an island', tanks.every((e) =>
  [-60, -40, -20, 0, 20, 40, 60].every((d) => islandAt(e.pos.z + d).amt === 0)));
// A battery must never fire at a plane too close to read the shell.
{
  const t = tanks[0];
  let shots = 0;
  const range = { fx: { muzzle() {} }, hostileFire() { shots++; } };
  const near = { pos: new THREE.Vector3(t.pos.x - t.side * 24, 6, t.pos.z), vx: 0, speed: 0 };
  for (let i = 0; i < 10 * 120; i++) stepEntity(t, DT, near, range);
  const nearShots = shots; shots = 0;
  const far = { pos: new THREE.Vector3(t.pos.x - t.side * 60, 6, t.pos.z), vx: 0, speed: 0 };
  for (let i = 0; i < 10 * 120; i++) stepEntity(t, DT, far, range);
  check('a battery holds fire at point-blank range, and fires from a readable one', nearShots === 0 && shots >= 2,
    `24 units: ${nearShots} shots; 60 units: ${shots} shots in 10 s`);
}

const depots = world.ents.filter((e) => e.kind === 'fuel');
check('every depot lies in open water end to end', depots.length >= 8 && depots.every((e) =>
  [-1, 0, 1].every((k) => shoreSDF(e.pos.x - FUEL_HALF_W - 5, e.pos.z + k * FUEL_HALF_LEN) < -1 &&
    shoreSDF(e.pos.x + FUEL_HALF_W + 5, e.pos.z + k * FUEL_HALF_LEN) < -1)), `${depots.length} depots`);
let closest = Infinity;
for (const d of depots) for (const h of hostiles) closest = Math.min(closest, Math.abs(h.pos.z - d.pos.z));
check('no hostile is placed within 70 units of a depot', closest >= 70, `closest ${closest.toFixed(0)}`);
check('no depot sits under a bridge', depots.every((d) => {
  const kb = Math.round(d.pos.z / BRIDGE_SPACING); return kb < 1 || Math.abs(d.pos.z - kb * BRIDGE_SPACING) >= 100;
}));

// Ships: sail each one for 40 s and require water under the whole hull, always.
const ships = hostiles.filter((e) => e.kind === 'ship');
// The world's own ships rarely land beside an island, and that is the case the
// bug lived in — so launch one into both channels of every island as well.
const dice = mulberry32(7);
const islandZs = [];
for (let z = 0; z < 12000; z += 20) if (islandAt(z).amt > 0.9) { islandZs.push(z); z += 300; }
for (const z of islandZs) {
  for (let k = 0; k < 6; k++) {
    const x = pickChannelX(z, dice, 8);
    if (x === null) continue;
    const e = makeEntity('ship', x, 0, z + k * 12);
    e.vx = (k % 2 ? -1 : 1) * (8 + k * 2);
    ships.push(e);
  }
}
let aground = 0;
const fakePlayer = { pos: new THREE.Vector3(0, 6, -1e6), vx: 0, speed: 80 };
for (const e of ships) {
  for (let i = 0; i < 40 * 120; i++) {
    stepEntity(e, DT, fakePlayer, null);
    if (shoreSDF(e.pos.x - 5.5, e.pos.z) > -0.5 || shoreSDF(e.pos.x + 5.5, e.pos.z) > -0.5) { aground++; break; }
  }
}
const inIslandBand = ships.filter((e) => islandAt(e.pos.z).amt > 0).length;
check('no ship ever leaves the water', aground === 0 && inIslandBand >= 12, `${ships.length} ships, ${inIslandBand} beside an island, ${aground} aground`);

// Where a plane is put down, the centreline is open water for a good while.
const gates = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((k) => (k === 0 ? 0 : k * BRIDGE_SPACING + 45));
const landings = gates.map((gz) => {
  for (let d = 0; d <= 200; d += 2) if (shoreSDF(riverCenterX(gz + d), gz + d) > -8) return d;
  return Infinity;
});
check('start and every checkpoint open on clear centreline water', landings.every((d) => d === Infinity),
  `first land on the centreline after: ${landings.map((d) => (d === Infinity ? '-' : d)).join(' ')}`);

// --- double channels: long, straight, parallel, as in the original ---------
const stretches = [];
for (let k = 0; k < 12; k++) { const d = doubleChannel(k); if (d) stretches.push({ k, ...d }); }
check('even sectors have one long double channel, odd sectors are open river',
  stretches.map((d) => d.k + 1).join(' ') === '2 4 6 8 10 12' && stretches.every((d) => d.to - d.from >= 500),
  `sectors ${stretches.map((d) => d.k + 1).join(' ')}; ${stretches[0].to - stretches[0].from} units each`);

const arms = (z) => {
  const cx = riverCenterX(z), hw = riverHalfWidth(z), isl = islandAt(z);
  const icx = cx + isl.off, ihw = isl.hw * isl.amt;
  return { cx, left: icx - ihw - (cx - hw), right: cx + hw - (icx + ihw) };
};
let drift = 0; let narrowest = Infinity; let breathing = 0;
for (const d of stretches) {
  // The body of the stretch: past the prow, short of the tail.
  const ref = arms((d.from + d.to) / 2);
  for (let z = d.from + 40; z <= d.to - 100; z += 10) {
    const a = arms(z);
    drift = Math.max(drift, Math.abs(a.cx - ref.cx));
    narrowest = Math.min(narrowest, a.left, a.right);
    breathing = Math.max(breathing, Math.abs(a.left - ref.left), Math.abs(a.right - ref.right));
  }
}
check('through a double channel the river runs straight', drift < 6, `centreline moves at most ${drift.toFixed(1)} units over ~400`);
check('both arms are wide enough and hold their width', narrowest >= 28 - 1e-6 && breathing < 1,
  `narrowest arm ${narrowest.toFixed(1)}, width varies by ${breathing.toFixed(2)}`);

// "Narrow channel, and two of them in it": inside a double channel, no two
// hostiles share an arm at close quarters.
let tightest = Infinity;
const inArm = hostiles.filter((e) => e.kind !== 'tank' && islandAt(e.pos.z).amt > 0);
for (const a of inArm) for (const b of inArm) {
  if (a === b) continue;
  const sameArm = (a.pos.x < riverCenterX(a.pos.z) + islandAt(a.pos.z).off) === (b.pos.x < riverCenterX(b.pos.z) + islandAt(b.pos.z).off);
  if (sameArm) tightest = Math.min(tightest, Math.abs(a.pos.z - b.pos.z));
}
check('no two hostiles share an arm at close quarters', inArm.length >= 6 && tightest >= 45,
  `${inArm.length} hostiles in double channels, closest pair in one arm ${tightest.toFixed(0)} apart`);

// -------------------------------------------------------------------- game
const scene = new THREE.Scene();
const game = new Game(scene, null);
// An island-free reach long enough for any test here, found once.
let OPEN = 0;
for (let z = 400; z < 60000; z += 20) {
  let clear = true;
  for (let d = -40; d <= 1100 && clear; d += 20) if (islandAt(z + d).amt > 0) clear = false;
  if (clear) { OPEN = z; break; }
}
/** Empty world, plane parked mid-channel in open water, untouchable. */
const freeze = () => {
  game.clearEntities(); game.nextChunk = 1e9; game.score = 0;
  const p = game.player;
  p.pos.set(riverCenterX(OPEN), 6, OPEN); p.prevPos.copy(p.pos); p.vx = 0; p.invuln = 1e9;
};
/** Step the sim; `follow` keeps the plane on the centreline round the bends. */
const run = (seconds, inp, each, follow = true) => {
  for (let i = 0; i < seconds * 120; i++) {
    game.step(DT, inp);
    if (follow && !inp.lateral) game.player.pos.x = riverCenterX(game.player.pos.z);
    if (each && each() === false) break;
  }
};
const addDepot = (z) => {
  const tmp = { bridgesDown: new Set(), ents: [], add(e) { this.ents.push(e); } };
  spawnChunk(tmp, Math.floor(700 / CHUNK_LEN)); spawnChunk(tmp, Math.floor(700 / CHUNK_LEN) - 1); spawnChunk(tmp, Math.floor(700 / CHUNK_LEN) + 1);
  const d = tmp.ents.find((e) => e.kind === 'fuel');
  d.pos.set(riverCenterX(z), 0, z); d.prevPos.copy(d.pos); d.segs = 4; d.shield = 0;
  game.add(d); return d;
};

check('a new game opens on empty water', game.ents.filter((e) => HOSTILE.has(e.kind)).every((e) => e.pos.z >= RUNWAY));
run(3, input(), null, false);
check('a player who touches nothing survives the first three seconds', game.state === 'playing' && game.deaths.length === 0,
  JSON.stringify(game.deaths));
game.checkpointZ = 1045; game.player.invuln = 0; game.die('test');
run(3, input(), () => game.state !== 'playing', false);
check('a respawn opens on empty water too', game.state === 'playing' && Math.abs(game.player.pos.z - 1045) < 30 &&
  game.ents.filter((e) => HOSTILE.has(e.kind)).every((e) => e.pos.z >= 1045 + RUNWAY));
run(3, input(), null, false);
check('and a player who touches nothing survives three seconds of it', game.state === 'playing' && game.deaths.length === 1, JSON.stringify(game.deaths));

// --- depot: one letter per shot, nearest first, with a grace period --------
game.reset(); freeze();
let depot = addDepot(game.player.pos.z + 130);
const losses = [];
let last = 4;
run(6, input({ firing: true }), () => { if (depot.segs !== last) { losses.push(game.time); last = depot.segs; } });
const gaps = losses.slice(1).map((t, i) => t - losses[i]);
check('holding fire takes the depot one letter at a time', losses.length === 4 && gaps.every((g) => g >= 0.35 - 1e-6),
  `gaps ${gaps.map((g) => g.toFixed(2)).join(' ')} s`);
check('each letter scores 20; the depot is gone after the fourth', game.score === 80 && !game.ents.includes(depot));

game.reset(); freeze();
depot = addDepot(game.player.pos.z + 130);
run(6, input({ firing: true }), () => depot.segs === 4);
const after = depot.segs;
run(0.5, input());
check('letting go after the first letter keeps the other three', after === 3 && depot.segs === 3);

// --- refuelling: long enough to matter, and slower is better ---------------
const drink = (throttle) => {
  game.reset(); freeze(); game.fuel = 15;
  addDepot(game.player.pos.z + 200);
  let gained = 0; let prev = game.fuel;
  run(6, input({ throttle }), () => { const f = game.fuel; if (f > prev) gained += f - prev; prev = f; });
  return gained;
};
const cruise = drink(0); const slow = drink(-1); const fast = drink(1);
check('a full pass at cruise is worth about half a tank', cruise > 42 && cruise < 62, `${cruise.toFixed(0)}`);
check('throttling back drinks more, flat out less', slow > cruise + 12 && fast < cruise - 12,
  `slow ${slow.toFixed(0)}, cruise ${cruise.toFixed(0)}, fast ${fast.toFixed(0)}`);

game.reset(); freeze(); game.fuel = 45;
depot = addDepot(game.player.pos.z + 300); depot.segs = 2;
let g2 = 0; let pv = game.fuel;
run(6, input(), () => { if (game.fuel > pv) g2 += game.fuel - pv; pv = game.fuel; });
check('two letters left give about half the fuel', g2 > cruise * 0.38 && g2 < cruise * 0.68, `${g2.toFixed(0)} vs ${cruise.toFixed(0)}`);

// --- auto-fire spares the depot --------------------------------------------
game.reset(); freeze();
depot = addDepot(game.player.pos.z + 300);
run(6, input({ firing: true, autoFire: true }));
check('auto-fire holds while a depot is next down the barrel', depot.segs === 4 && game.player.pos.z > depot.pos.z);

// --- the angled shot --------------------------------------------------------
const angle = (throttle) => {
  game.reset(); freeze();
  run(2.5, input({ throttle }));
  let a = null;
  run(0.3, input({ throttle, lateral: 1, firingAlt: true }), () => {
    if (a) return false;
    // The newest shot: the first ones leave before the plane has any sideways speed.
    const b = game.bullets.at(-1);
    if (b && Math.abs(b.vx) > 100 && Math.abs(game.player.vx) > 47) { a = { deg: Math.atan2(Math.abs(b.vx), b.vz) * 180 / Math.PI, sameSide: Math.sign(b.vx) === Math.sign(game.player.vx) }; return false; }
  });
  return a;
};
const aFast = angle(1); const aCruise = angle(0); const aSlow = angle(-1);
check('X fires on the diagonal, toward the side the plane is moving', !!aCruise && aCruise.sameSide && aCruise.deg > 24 && aCruise.deg < 40,
  aCruise ? `${aCruise.deg.toFixed(0)}° at cruise` : 'no angled bullet');
check('the slower the plane, the wider the angle', !!(aSlow && aCruise && aFast) && aSlow.deg > aCruise.deg + 2 && aCruise.deg > aFast.deg + 2,
  aSlow && aCruise && aFast ? `fast ${aFast.deg.toFixed(0)}°, cruise ${aCruise.deg.toFixed(0)}°, slow ${aSlow.deg.toFixed(0)}°` : 'missing');

// --- shots stop at the bank -------------------------------------------------
game.reset(); game.clearEntities(); game.nextChunk = 1e9; game.player.invuln = 1e9;
let through = 0;
let stopped = 0;
const impact = game.fx.impact.bind(game.fx);
game.fx.impact = (p) => { stopped++; impact(p); };
// Straight down the start of the river, no steering: every shot must end on a bank.
run(8, input({ firing: true }), () => { for (const b of game.bullets) if (shoreSDF(b.pos.x, b.pos.z) > 8) through++; });
game.fx.impact = impact;
check('shots stop at the bank instead of flying through it', through === 0 && stopped > 5, `${stopped} stopped`);

// --- the battery has an answer ---------------------------------------------
// The way a person does it: flying up the lane 22 units off the battery's
// bank, swing toward it and hold X for under half a second. Tried from a
// spread of distances, because "possible from exactly one spot" is not an
// answer to a threat.
const tryKill = (tank, lead) => {
  game.reset(); game.clearEntities(); game.clearUntil = -Infinity;
  spawnChunk(game, Math.floor(tank.pos.z / CHUNK_LEN));
  game.nextChunk = 1e9; game.score = 0; game.player.invuln = 1e9;
  for (let i = game.ents.length - 1; i >= 0; i--) if (game.ents[i].kind !== 'tank') { game.remove(game.ents[i]); game.ents.splice(i, 1); }
  const t = game.ents.find((e) => Math.abs(e.pos.z - tank.pos.z) < 1);
  if (!t) return false;
  const p = game.player;
  p.pos.set(t.pos.x - t.side * 22, 6, t.pos.z - lead); p.prevPos.copy(p.pos); p.vx = 0; game.altCooldown = 0;
  run(0.45, input({ lateral: -t.side, firingAlt: true }), () => game.ents.includes(t), false);
  run(1.2, input(), () => game.ents.includes(t), false);
  return !game.ents.includes(t) && game.score === SPEC.tank.score;
};
// Sampled every 2 units: the window is the stretch of approach, in world
// units, over which starting the swing ends in a kill. At cruise the plane
// covers 80 units a second.
const leads = [];
for (let l = 10; l <= 150; l += 2) leads.push(l);
const windows = tanks.slice(0, 6).map((t) => leads.filter((l) => tryKill(t, l)));
const widths = windows.map((w) => (w.length ? w.at(-1) - w[0] + 2 : 0));
check('a swing-and-fire destroys a shore battery from a usable window', Math.min(...widths) >= 30,
  `worth ${SPEC.tank.score}; window per battery: ${windows.map((w, i) => (w.length ? `${w[0]}-${w.at(-1)} (${widths[i]}u, ${(widths[i] / 80).toFixed(2)}s)` : 'none')).join(' | ')}`);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} simulation checks passed`);
process.exit(failed ? 1 : 0);
