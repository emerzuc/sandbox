import * as THREE from 'three';
import { Player, WING_HALF, PLAYER_Y } from './player.js';
import {
  spawnChunk, stepEntity, syncEntityMesh, makeEntityMesh,
  SPEC, BRIDGE_SPACING, RUNWAY,
  FUEL_SEGS, FUEL_SEG_LEN, FUEL_HALF_W, FUEL_HALF_LEN,
} from './entities.js';
import { CHUNK_LEN } from '../world/terrain.js';
import { shoreSDF, riverCenterX } from '../world/river.js';
import { BULLET_GEO, MAT, makePlane } from '../view/shapes.js';
import { FX } from '../view/fx.js';
import { clamp, clamp01, damp, lerp } from '../core/math.js';
import { PALETTE, biomeAt } from '../art/direction.js';
import { WATER_Y } from '../world/river.js';

const SPAWN_AHEAD = 1020;
const CULL_BEHIND = 90;

export const FUEL_MAX = 100;
const FUEL_DRAIN_BASE = 1.55;
const FUEL_DRAIN_SPEED = 2.6;
// Tuned to the depot's length: a clean pass over all four letters at cruise is
// worth about half a tank, throttled right back nearly a full one, flat out a
// third. Every letter shot away takes its quarter with it. Speed costs fuel
// twice — once to burn, once to miss.
const FUEL_REFILL = 84;
// How far to the side of the depot the plane still drinks.
const FUEL_REACH = 4.5;
// After a letter goes, the next one cannot be hit for this long. Holding the
// trigger would otherwise erase the whole depot in under half a second; this
// leaves time to notice and let go. Shots that arrive meanwhile are absorbed.
const FUEL_SHIELD = 0.35;

const FIRE_COOLDOWN = 0.115;
const BULLET_REL_SPEED = 205;
const BULLET_LIFE = 2.6;

/**
 * The angled shot. It inherits the plane's sideways motion, so it leaves on a
 * diagonal toward whichever bank the plane is swinging at — the only way to
 * reach a shore battery. It is slower than the main gun, and its forward speed
 * is tied to the plane's own, so the slower the plane the wider the angle:
 * about 26 degrees flat out, 32 at cruise, 37 throttled back.
 */
const ALT_COOLDOWN = 0.13;
// The angled round bursts where it meets the bank. Measured without this, a
// battery could only be killed by a shot released inside a 20-unit stretch of
// the approach — a quarter of a second. A threat needs an answer a person can
// actually give, so a near miss on the bank counts.
const ALT_SPLASH = 12;
const ALT_FWD_SPEED = 95;
const ALT_LATERAL = 2.3;
const ALT_LIFE = 2.0;

// A shot this far past the waterline has met the bank. The bank is a cliff, so
// by here it stands as tall as the shot flies.
const BANK_HIT_SDF = 5;

// Auto-fire (a thumb on glass, the autopilot) holds its fire when the next
// thing down the barrel is a depot within this range.
const HOLD_FIRE_RANGE = 450;

const PLAYER_R = 3.2;

/**
 * Entities live on their own render layer. The water's mirrored camera sees
 * layer 0 only, so a boat's reflection — three or four draw calls, doubled,
 * for a smudge under a hull — is never rendered; the plane stays on layer 0
 * because its reflection is a position cue. Sector 6 runs ~27 entities, and
 * this is the difference between 250 draws and the ceiling.
 */
const ENTITY_LAYER = 1;

// Hostile projectiles are owned here, not by the entities that fire them:
// one pool, one collision path, one place to tune. Same dart as the player's
// tracer in the hostile accent colour, so "that is coming at me" reads at a
// glance.
const HOSTILE_SHOT_LIFE = 3.2;
const HOSTILE_SHOT_R = 1.7;
// Brighter than display white on purpose: the scene target is half-float, so
// this lands above the bloom threshold and the shell carries its own glow. The
// first version was the dark hostile accent on dark water — a threat the
// player was expected to dodge and could not see.
const HOSTILE_MAT = new THREE.MeshBasicMaterial({
  color: new THREE.Color(PALETTE.hostileTracer).multiplyScalar(2.6),
});
const HOSTILE_SHOT_SCALE = [2.6, 2.6, 1.9];

const HITSTOP_KILL = 0.055;
const HITSTOP_BRIDGE = 0.11;
const HITSTOP_DEATH = 0.16;

const DYING_TIME = 1.15;

/**
 * Low-fuel tension. The old ramp started at 0 when the tank crossed 30% and
 * only reached 1 at empty, so the warning became unmistakable about four
 * seconds before death — with the next depot nine seconds away. It warned of
 * dying, not of needing fuel. Now it *steps in* at the threshold and climbs
 * from there. The sim owns this clock; audio and HUD both read it, so the
 * heartbeat you hear and the pulse you see are the same beat.
 */
const LOW_FUEL = 0.3;
const LOW_FUEL_STEP = 0.35;
const EMERGENCY_FUEL = 0.15;
const ALARM_REPEAT = 4;

/**
 * A graze is a wingtip on rock with the hull still over water. It does not
 * kill; it costs fuel — the game's real clock — twice: a bite on contact, and
 * a leak for a few seconds after, so the punishment is visible on the gauge
 * and pushes the player toward the next depot, which is where the risk lives.
 */
const GRAZE_BITE = 9;
const LEAK_TIME = 4;
const LEAK_MULT = 2.6;
const GRAZE_PUSH = 28;
const SPARK_INTERVAL = 0.045;
const HULL_MARGIN = -1.2;
const SHORE_WARN_RANGE = 8;

export class Game {
  constructor(scene, audio, { lives = 3 } = {}) {
    this.scene = scene;
    this.audio = audio;
    this.startLives = lives;
    this.fx = new FX(scene);
    this.player = new Player();

    this.planeMesh = makePlane();
    scene.add(this.planeMesh);

    this.ents = [];
    this.bullets = [];
    this.bulletPool = [];
    this.shots = [];
    this.shotPool = [];
    this._aim = new THREE.Vector3();

    this.bridgesDown = new Set();
    this.deaths = [];
    this._tip = new THREE.Vector3();

    this.reset();
  }

  reset() {
    this.clearEntities();
    this.bridgesDown.clear();
    this.deaths = [];

    this.score = 0;
    this.lives = this.startLives;
    this.fuel = FUEL_MAX;
    this.checkpointZ = 0;
    this.state = 'playing';
    this.dyingT = 0;
    this.hitstop = 0;
    this.trauma = 0;
    this.time = 0;

    this.overT = 0;
    this.altCooldown = 0;
    this.clearUntil = RUNWAY;
    this.lowMix = 0;
    this.beatPhase = 0;
    this.beatEdge = false;
    this.alarmT = 0;
    this.leakT = 0;
    this.grazing = 0;
    this.sparkT = 0;
    this.shoreL = 0;
    this.shoreR = 0;

    this.nextChunk = -1;
    this.player.reset(riverCenterX(0), 0);
    this.player.invuln = 0;
    this.spawnAhead();
  }

  get sector() {
    return Math.max(1, Math.floor(this.player.pos.z / BRIDGE_SPACING) + 1);
  }

  // ---------------------------------------------------------------- entities

  add(e) {
    e.mesh = makeEntityMesh(e.kind);
    e.mesh.traverse((o) => o.layers.set(ENTITY_LAYER));
    // Scenery is painted with the terrain's palette, and the terrain's palette
    // travels: a rock spawned in the basalt gorge must be basalt. Rocks are
    // rare enough that a cloned material each is cheaper than a uniform.
    if (e.kind === 'rock') {
      const b = biomeAt(e.pos.z);
      e.mesh.traverse((o) => {
        if (!o.isMesh) return;
        const top = o.material === MAT.rockTop;
        o.material = o.material.clone();
        o.material.color.copy(top ? b.rockHigh : b.rockCliff);
      });
    }
    e.mesh.position.copy(e.pos);
    this.scene.add(e.mesh);
    this.ents.push(e);
  }

  remove(e) {
    if (e.mesh) this.scene.remove(e.mesh);
    e.mesh = null;
  }

  clearEntities() {
    for (const e of this.ents) this.remove(e);
    this.ents.length = 0;
    for (const b of this.bullets) this.recycleBullet(b);
    this.bullets.length = 0;
    for (const s of this.shots) this.recycleShot(s);
    this.shots.length = 0;
  }

  spawnAhead() {
    const limit = this.player.pos.z + SPAWN_AHEAD;
    let guard = 64;
    while (this.nextChunk * CHUNK_LEN < limit && guard-- > 0) {
      spawnChunk(this, this.nextChunk);
      this.nextChunk++;
    }
  }

  // ----------------------------------------------------------------- bullets

  fire(angled = false) {
    const p = this.player;
    let b = this.bulletPool.pop();
    if (!b) {
      b = {
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vx: 0,
        vz: 0,
        life: 0,
        angled: false,
        mesh: new THREE.Mesh(BULLET_GEO, MAT.bullet),
      };
    }
    b.pos.set(p.pos.x, p.pos.y - 0.2, p.pos.z + 5.5);
    b.prevPos.copy(b.pos);
    b.angled = angled;
    b.vx = angled ? p.vx * ALT_LATERAL : 0;
    b.vz = p.speed + (angled ? ALT_FWD_SPEED : BULLET_REL_SPEED);
    b.life = angled ? ALT_LIFE : BULLET_LIFE;
    b.mesh.position.copy(b.pos);
    b.mesh.rotation.y = Math.atan2(b.vx, b.vz);
    this.scene.add(b.mesh);
    this.bullets.push(b);
    this.fx.muzzle(b.pos);
    this.audio?.event('shot');
    if (angled) this.altCooldown = ALT_COOLDOWN; else p.fireCooldown = FIRE_COOLDOWN;
  }

  recycleBullet(b) {
    this.scene.remove(b.mesh);
    this.bulletPool.push(b);
  }

  // ------------------------------------------------------------ hostile fire

  /** Contract for entities.js: spawn a straight-line hostile projectile. */
  hostileFire(x, y, z, vx, vy, vz) {
    let s = this.shotPool.pop();
    if (!s) {
      s = {
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        origin: new THREE.Vector3(),
        life: 0,
        mesh: new THREE.Mesh(BULLET_GEO, HOSTILE_MAT),
      };
      s.mesh.scale.fromArray(HOSTILE_SHOT_SCALE);
    }
    s.pos.set(x, y, z);
    s.prevPos.copy(s.pos);
    s.origin.copy(s.pos);
    s.vel.set(vx, vy, vz);
    s.life = HOSTILE_SHOT_LIFE;
    s.mesh.position.copy(s.pos);
    this._aim.copy(s.pos).add(s.vel);
    s.mesh.lookAt(this._aim);
    this.scene.add(s.mesh);
    this.shots.push(s);
  }

  recycleShot(s) {
    this.scene.remove(s.mesh);
    this.shotPool.push(s);
  }

  stepShots(dt) {
    const pz = this.player.pos.z;
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      s.prevPos.copy(s.pos);
      s.pos.addScaledVector(s.vel, dt);
      s.life -= dt;
      const gone = s.life <= 0 || s.pos.z < pz - 60 || s.pos.z > pz + SPAWN_AHEAD;
      if (s.pos.y <= WATER_Y + 0.2) {
        this.fx.impact(s.pos);
        this.recycleShot(s);
        this.shots.splice(i, 1);
      } else if (gone) {
        this.recycleShot(s);
        this.shots.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------- feel

  kick(trauma, hitstop) {
    this.trauma = clamp01(this.trauma + trauma);
    this.hitstop = Math.max(this.hitstop, hitstop);
  }

  // --------------------------------------------------------------------- sim

  step(dt, input) {
    // Hitstop freezes the simulation but not the frame. This is the cheapest
    // and most effective piece of game feel there is.
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      return;
    }

    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.5);

    if (this.state === 'gameover') {
      // A short lockout: the player is usually still mashing fire when the
      // last plane goes, and with touch a tap is both. Presses latched before
      // the card has been readable are thrown away, not honoured late.
      this.overT += dt;
      const pressed = input.consumeRestart();
      if (pressed && this.overT > 0.9) this.reset();
      return;
    }

    if (this.state === 'dying') {
      this.lowMix = damp(this.lowMix, 0, 3, dt);
      this.beatEdge = false;
      this.dyingT -= dt;
      if (this.dyingT <= 0) this.afterDeath();
      return;
    }

    const p = this.player;
    p.step(dt, input);

    const tapped = input.consumeFire();
    const hold = input.autoFire && this.depotDownTheBarrel();
    if (!hold && (input.firing || tapped) && p.fireCooldown <= 0) this.fire();

    this.altCooldown = Math.max(0, this.altCooldown - dt);
    const tappedAlt = input.consumeFireAlt();
    if ((input.firingAlt || tappedAlt) && this.altCooldown <= 0) this.fire(true);

    const fuelBefore = this.fuel;
    this.leakT = Math.max(0, this.leakT - dt);
    const leak = this.leakT > 0 ? LEAK_MULT : 1;
    this.fuel -= (FUEL_DRAIN_BASE + p.speed01 * FUEL_DRAIN_SPEED) * leak * dt;
    this.stepTension(dt, fuelBefore);

    this.spawnAhead();
    this.stepBullets(dt);
    this.stepEnts(dt);
    this.stepShots(dt);
    this.collide(dt);

    if (this.fuel <= 0) {
      this.fuel = 0;
      this.die('fuel');
    }
  }

  stepTension(dt, fuelBefore) {
    const fuel01 = this.fuel / FUEL_MAX;
    const target = fuel01 < LOW_FUEL ? LOW_FUEL_STEP + (1 - LOW_FUEL_STEP) * (1 - fuel01 / LOW_FUEL) : 0;
    this.lowMix = damp(this.lowMix, target, 1.8, dt);

    this.beatEdge = false;
    if (this.lowMix > 0.04) {
      this.beatPhase += (dt * lerp(56, 150, this.lowMix)) / 60;
      if (this.beatPhase >= 1) {
        this.beatPhase -= 1;
        this.beatEdge = true;
      }
    } else {
      this.beatPhase = 0;
    }

    const lowMark = FUEL_MAX * LOW_FUEL;
    this.alarmT -= dt;
    if (fuelBefore >= lowMark && this.fuel < lowMark) {
      this.audio?.event('lowfuel');
      this.alarmT = ALARM_REPEAT;
    } else if (fuel01 < 0.2 && this.alarmT <= 0) {
      this.audio?.event('lowfuel');
      this.alarmT = ALARM_REPEAT;
    }
  }

  get emergency() {
    return this.fuel / FUEL_MAX < EMERGENCY_FUEL;
  }

  stepBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.prevPos.copy(b.pos);
      b.pos.x += b.vx * dt;
      b.pos.z += b.vz * dt;
      b.life -= dt;
      // Shots stop at the bank and at islands. They used to fly through the
      // terrain, which was invisible while every shot went straight up-river
      // and is not once a shot can be aimed at the shore.
      const banked = shoreSDF(b.pos.x, b.pos.z) > BANK_HIT_SDF;
      if (banked) {
        // The burst is drawn at the size it acts at, so the reach is visible.
        if (b.angled) { this.fx.explosion(b.pos, 0.5); this.burstOnBank(b); } else this.fx.impact(b.pos);
      }
      if (banked || b.life <= 0 || b.pos.z > this.player.pos.z + SPAWN_AHEAD) {
        this.recycleBullet(b);
        this.bullets.splice(i, 1);
      }
    }
  }

  /** An angled round bursting on the bank takes any battery close by with it. */
  burstOnBank(b) {
    for (let i = this.ents.length - 1; i >= 0; i--) {
      const e = this.ents[i];
      if (e.kind !== 'tank') continue;
      const dx = e.pos.x - b.pos.x;
      const dz = e.pos.z - b.pos.z;
      if (dx * dx + dz * dz < ALT_SPLASH * ALT_SPLASH) this.destroy(e, i);
    }
  }

  stepEnts(dt) {
    const behind = this.player.pos.z - CULL_BEHIND;
    for (let i = this.ents.length - 1; i >= 0; i--) {
      const e = this.ents[i];
      stepEntity(e, dt, this.player, this);
      if (e.pos.z < behind) {
        this.remove(e);
        this.ents.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------- collisions

  collide(dt) {
    const p = this.player;

    // Bullets vs. everything shootable.
    for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
      const b = this.bullets[bi];
      for (let ei = this.ents.length - 1; ei >= 0; ei--) {
        const e = this.ents[ei];
        if (!this.bulletHits(b, e)) continue;
        if (e.kind === 'fuel') this.hitDepot(e, ei); else this.destroy(e, ei);
        this.recycleBullet(b);
        this.bullets.splice(bi, 1);
        break;
      }
    }

    // Refuelling is not a collision. It used to sit below the invulnerability
    // early-out, so a plane fresh from a respawn flew over a depot and got
    // nothing.
    for (const e of this.ents) {
      if (e.kind !== 'fuel') continue;
      if (
        Math.abs(p.pos.x - e.pos.x) < FUEL_HALF_W + FUEL_REACH &&
        p.pos.z > this.depotNearZ(e) - 3 && p.pos.z < e.pos.z + FUEL_HALF_LEN + 3
      ) {
        this.fuel = Math.min(FUEL_MAX, this.fuel + FUEL_REFILL * dt);
        this.audio?.event('refuel');
      }
    }

    if (p.invuln > 0) return;

    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const dx = p.pos.x - s.pos.x;
      const dy = p.pos.y - s.pos.y;
      const dz = p.pos.z - s.pos.z;
      if (dx * dx + dy * dy + dz * dz < (PLAYER_R + HOSTILE_SHOT_R) ** 2) {
        this.die('shot', {
          from: [Math.round(s.origin.x), Math.round(s.origin.y), Math.round(s.origin.z)],
          vel: [Math.round(s.vel.x), Math.round(s.vel.y), Math.round(s.vel.z)],
          at: [Math.round(p.pos.x), Math.round(p.pos.z)],
        });
        return;
      }
    }

    // Player vs. shoreline, against the same SDF the mesh was generated from —
    // so what looks like water always is water. The hull (centre and nose)
    // kills; a wingtip alone is a graze.
    const z = p.pos.z;
    const sdL = shoreSDF(p.pos.x - WING_HALF, z);
    const sdR = shoreSDF(p.pos.x + WING_HALF, z);
    this.shoreL = clamp01(1 + sdL / SHORE_WARN_RANGE);
    this.shoreR = clamp01(1 + sdR / SHORE_WARN_RANGE);

    if (shoreSDF(p.pos.x, z) > HULL_MARGIN || shoreSDF(p.pos.x, z + 4.5) > HULL_MARGIN) {
      this.die('terrain');
      return;
    }

    const grazeL = sdL > -0.4;
    const grazeR = sdR > -0.4;
    if (grazeL || grazeR) {
      // Both wings on rock means the channel is narrower than the plane, which
      // the generator forbids; if it ever happens, it is a wall, not a graze.
      if (grazeL && grazeR) { this.die('terrain'); return; }
      const dir = grazeL ? 1 : -1;
      if (!this.grazing) this.fuel = Math.max(0, this.fuel - GRAZE_BITE);
      this.leakT = LEAK_TIME;
      this.grazing = 1;
      // Shove away from the wall; the bank angle follows from vx on its own.
      p.vx = dir * Math.max(Math.abs(p.vx) * 0.4, GRAZE_PUSH);
      this.kick(0.12, 0);
      this.sparkT -= dt;
      if (this.sparkT <= 0) {
        this.sparkT = SPARK_INTERVAL;
        this._tip.set(p.pos.x - dir * WING_HALF, p.pos.y, z);
        this.fx.impact(this._tip);
      }
      this.audio?.event('scrape', { pan: -dir });
    } else {
      this.grazing = 0;
      this.sparkT = 0;
    }

    // Player vs. entities.
    for (let i = this.ents.length - 1; i >= 0; i--) {
      const e = this.ents[i];

      // Scenery, and a battery dug into the bank: the land they stand on is
      // what kills, and it already has. A depot is flown over, not into.
      if (e.kind === 'rock' || e.kind === 'tank' || e.kind === 'fuel') continue;

      if (e.kind === 'bridge') {
        if (Math.abs(z - e.pos.z) < 5.5 && Math.abs(p.pos.x - e.pos.x) < e.halfWidth) {
          this.die('bridge');
          return;
        }
        continue;
      }

      const dx = p.pos.x - e.pos.x;
      const dy = p.pos.y - e.pos.y;
      const dz = z - e.pos.z;
      const rr = (PLAYER_R + e.r) ** 2;
      if (dx * dx + dy * dy + dz * dz > rr) continue;

      this.die(e.kind);
      return;
    }
  }

  // ------------------------------------------------------------- fuel depot

  /** World z of the near end of the letters still standing. */
  depotNearZ(e) {
    return e.pos.z - FUEL_HALF_LEN + (FUEL_SEGS - e.segs) * FUEL_SEG_LEN;
  }

  /** One shot, one letter — nearest first. Inside the grace period: nothing. */
  hitDepot(e, index) {
    if (e.shield > 0) return;
    this._tip.set(e.pos.x, 3, this.depotNearZ(e) + FUEL_SEG_LEN / 2);
    e.segs -= 1;
    e.shield = FUEL_SHIELD;
    this.score += SPEC.fuel.score;
    this.fx.explosion(this._tip, 0.9);
    this.audio?.event('explosion', { pan: clamp((e.pos.x - this.player.pos.x) / 40, -1, 1) });
    this.kick(0.22, HITSTOP_KILL * 0.6);
    if (e.segs <= 0) {
      this.remove(e);
      this.ents.splice(index, 1);
    }
  }

  /**
   * Is a depot the next thing in the line of fire? A hostile nearer than the
   * depot on the same line still gets shot at — the depot only shields what is
   * behind it.
   */
  depotDownTheBarrel() {
    const p = this.player;
    let depot = Infinity;
    let hostile = Infinity;
    for (const e of this.ents) {
      const dx = Math.abs(e.pos.x - p.pos.x);
      if (e.kind === 'fuel') {
        if (dx > FUEL_HALF_W + 2 || e.pos.z + FUEL_HALF_LEN < p.pos.z) continue;
        depot = Math.min(depot, this.depotNearZ(e) - p.pos.z);
      } else if (e.kind !== 'rock' && e.kind !== 'bridge' && e.kind !== 'tank') {
        const dz = e.pos.z - p.pos.z;
        if (dz > 0 && dx < e.r + 2) hostile = Math.min(hostile, dz);
      }
    }
    return depot < HOLD_FIRE_RANGE && depot < hostile;
  }

  bulletHits(b, e) {
    if (e.kind === 'rock' || SPEC[e.kind].shootable === false) return false;
    if (e.kind === 'fuel') {
      // Plan view, as in the original: the letters lie flat under the shot.
      return (
        Math.abs(b.pos.x - e.pos.x) < FUEL_HALF_W + 0.7 &&
        b.pos.z > this.depotNearZ(e) - 1.5 && b.pos.z < e.pos.z + FUEL_HALF_LEN
      );
    }
    if (e.kind === 'bridge') {
      return (
        Math.abs(b.pos.z - e.pos.z) < 6 &&
        Math.abs(b.pos.x - e.pos.x) < e.halfWidth &&
        b.pos.y > 4 && b.pos.y < 11
      );
    }
    const dx = b.pos.x - e.pos.x;
    const dy = b.pos.y - e.pos.y - (SPEC[e.kind].hitY || 0);
    const dz = b.pos.z - e.pos.z;
    return dx * dx + dy * dy + dz * dz < (e.r + 1.4) ** 2;
  }

  destroy(e, index) {
    this.score += SPEC[e.kind].score;

    // Pan is relative to the player, not the camera: the camera is locked
    // behind the plane, so the two agree and this is the cheaper of the pair.
    const pan = clamp((e.pos.x - this.player.pos.x) / 40, -1, 1);

    if (e.kind === 'bridge') {
      this.bridgesDown.add(e.sector);
      this.checkpointZ = e.pos.z + 45;
      this.fx.explosion(e.pos, 2.5);
      this.audio?.event('bridge', { pan });
      this.kick(0.85, HITSTOP_BRIDGE);
    } else {
      this.fx.explosion(e.pos, e.kind === 'tank' ? 1.4 : 1);
      this.audio?.event('explosion', { pan });
      this.kick(e.kind === 'jet' ? 0.4 : 0.3, HITSTOP_KILL);
    }

    this.remove(e);
    this.ents.splice(index, 1);
  }

  die(cause = 'unknown', info = null) {
    if (this.state !== 'playing') return;
    this.deaths.push({ cause, z: Math.round(this.player.pos.z), t: +this.time.toFixed(1), ...(info ?? {}) });
    this.state = 'dying';
    this.dyingT = DYING_TIME;
    this.fx.explosion(this.player.pos, 1.6);
    this.audio?.event('death', { cause });
    this.kick(1, HITSTOP_DEATH);
  }

  afterDeath() {
    this.lives -= 1;
    if (this.lives <= 0) {
      this.state = 'gameover';
      this.overT = 0;
      return;
    }
    const z = this.checkpointZ;
    this.clearUntil = z + RUNWAY;
    this.clearEntities();
    this.nextChunk = Math.floor(z / CHUNK_LEN) - 1;
    this.player.reset(riverCenterX(z), z);
    this.fuel = FUEL_MAX;
    this.state = 'playing';
    this.spawnAhead();
  }

  // ------------------------------------------------------------------ render

  /** Push interpolated sim state into the scene graph. */
  render(alpha) {
    const p = this.player;
    this.planeMesh.position.lerpVectors(p.prevPos, p.pos, alpha);
    this.planeMesh.rotation.z = p.prevRoll + (p.roll - p.prevRoll) * alpha;
    this.planeMesh.rotation.y = (-p.vx / 48) * 0.16;
    this.planeMesh.visible =
      this.state === 'playing' && (p.invuln <= 0 || Math.floor(this.time * 14) % 2 === 0);

    for (const e of this.ents) syncEntityMesh(e, alpha);
    for (const b of this.bullets) b.mesh.position.lerpVectors(b.prevPos, b.pos, alpha);
    for (const s of this.shots) s.mesh.position.lerpVectors(s.prevPos, s.pos, alpha);
  }

  /** Camera shake amplitude, 0..1, with the usual squared falloff. */
  get shake() {
    return this.trauma * this.trauma;
  }
}
