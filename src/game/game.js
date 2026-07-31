import * as THREE from 'three';
import { Player, WING_HALF, PLAYER_Y } from './player.js';
import {
  spawnChunk, stepEntity, syncEntityMesh, makeEntityMesh,
  SPEC, BRIDGE_SPACING,
} from './entities.js';
import { CHUNK_LEN } from '../world/terrain.js';
import { shoreSDF, riverCenterX } from '../world/river.js';
import { BULLET_GEO, DEBRIS_GEO, MAT } from '../view/shapes.js';
import { makePlane } from '../view/shapes.js';
import { clamp, clamp01 } from '../core/math.js';

const SPAWN_AHEAD = 1020;
const CULL_BEHIND = 90;

export const FUEL_MAX = 100;
const FUEL_DRAIN_BASE = 1.55;
const FUEL_DRAIN_SPEED = 2.6;
// A depot pass lasts about a third of a second at cruise, so the rate has to
// be large for the pickup to mean anything. This is deliberately tuned so one
// clean pass is worth roughly half a tank: two or three depots to refill from
// empty, and flying slower over one earns more — speed costs fuel twice.
const FUEL_REFILL = 155;

const FIRE_COOLDOWN = 0.115;
const BULLET_REL_SPEED = 205;
const BULLET_LIFE = 2.6;

const PLAYER_R = 3.2;

const HITSTOP_KILL = 0.055;
const HITSTOP_BRIDGE = 0.11;
const HITSTOP_DEATH = 0.16;

const DYING_TIME = 1.15;

export class Game {
  constructor(scene) {
    this.scene = scene;
    this.player = new Player();

    this.planeMesh = makePlane();
    scene.add(this.planeMesh);

    this.ents = [];
    this.bullets = [];
    this.bulletPool = [];
    this.debris = [];
    this.debrisPool = [];

    this.bridgesDown = new Set();
    this.deaths = [];

    this.reset();
  }

  reset() {
    this.clearEntities();
    this.bridgesDown.clear();
    this.deaths = [];

    this.score = 0;
    this.lives = 3;
    this.fuel = FUEL_MAX;
    this.checkpointZ = 0;
    this.state = 'playing';
    this.dyingT = 0;
    this.hitstop = 0;
    this.trauma = 0;
    this.time = 0;

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
    for (const d of this.debris) this.recycleDebris(d);
    this.debris.length = 0;
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

  fire() {
    const p = this.player;
    let b = this.bulletPool.pop();
    if (!b) {
      b = {
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vz: 0,
        life: 0,
        mesh: new THREE.Mesh(BULLET_GEO, MAT.bullet),
      };
    }
    b.pos.set(p.pos.x, p.pos.y - 0.2, p.pos.z + 5.5);
    b.prevPos.copy(b.pos);
    b.vz = p.speed + BULLET_REL_SPEED;
    b.life = BULLET_LIFE;
    b.mesh.position.copy(b.pos);
    this.scene.add(b.mesh);
    this.bullets.push(b);
    p.fireCooldown = FIRE_COOLDOWN;
  }

  recycleBullet(b) {
    this.scene.remove(b.mesh);
    this.bulletPool.push(b);
  }

  // ------------------------------------------------------------------ debris

  spawnDebris(at, count, spread = 26) {
    for (let i = 0; i < count; i++) {
      let d = this.debrisPool.pop();
      if (!d) {
        d = {
          pos: new THREE.Vector3(),
          prevPos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          spin: new THREE.Vector3(),
          life: 0,
          mesh: new THREE.Mesh(DEBRIS_GEO, MAT.hostile),
        };
      }
      d.pos.copy(at);
      d.prevPos.copy(at);
      const a = (i / count) * Math.PI * 2 + this.time;
      d.vel.set(
        Math.cos(a) * spread * (0.4 + (i % 3) * 0.3),
        14 + (i % 4) * 7,
        Math.sin(a) * spread * (0.4 + (i % 3) * 0.3)
      );
      d.spin.set(4 + i, 3 + i * 0.7, 5 - i * 0.4);
      d.life = 1.0 + (i % 3) * 0.25;
      const s = 0.6 + (i % 4) * 0.35;
      d.mesh.scale.setScalar(s);
      this.scene.add(d.mesh);
      this.debris.push(d);
    }
  }

  recycleDebris(d) {
    this.scene.remove(d.mesh);
    this.debrisPool.push(d);
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
      if (input.consumeRestart()) this.reset();
      return;
    }

    if (this.state === 'dying') {
      this.stepDebris(dt);
      this.dyingT -= dt;
      if (this.dyingT <= 0) this.afterDeath();
      return;
    }

    const p = this.player;
    p.step(dt, input);

    if (input.firing && p.fireCooldown <= 0) this.fire();
    else if (input.consumeFire() && p.fireCooldown <= 0) this.fire();
    else input.consumeFire();

    this.fuel -= (FUEL_DRAIN_BASE + p.speed01 * FUEL_DRAIN_SPEED) * dt;

    this.spawnAhead();
    this.stepBullets(dt);
    this.stepEnts(dt);
    this.stepDebris(dt);
    this.collide(dt);

    if (this.fuel <= 0) {
      this.fuel = 0;
      this.die('fuel');
    }
  }

  stepBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.prevPos.copy(b.pos);
      b.pos.z += b.vz * dt;
      b.life -= dt;
      if (b.life <= 0 || b.pos.z > this.player.pos.z + SPAWN_AHEAD) {
        this.recycleBullet(b);
        this.bullets.splice(i, 1);
      }
    }
  }

  stepEnts(dt) {
    const behind = this.player.pos.z - CULL_BEHIND;
    for (let i = this.ents.length - 1; i >= 0; i--) {
      const e = this.ents[i];
      stepEntity(e, dt, this.player);
      if (e.pos.z < behind) {
        this.remove(e);
        this.ents.splice(i, 1);
      }
    }
  }

  stepDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.prevPos.copy(d.pos);
      d.vel.y -= 62 * dt;
      d.pos.addScaledVector(d.vel, dt);
      d.life -= dt;
      if (d.life <= 0) {
        this.recycleDebris(d);
        this.debris.splice(i, 1);
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
        this.destroy(e, ei);
        this.recycleBullet(b);
        this.bullets.splice(bi, 1);
        break;
      }
    }

    if (p.invuln > 0) return;

    // Player vs. shoreline. Sampled at both wingtips and slightly ahead of the
    // nose, against the same SDF the mesh was generated from — so what looks
    // like water always is water.
    const z = p.pos.z;
    if (
      shoreSDF(p.pos.x - WING_HALF, z) > -0.4 ||
      shoreSDF(p.pos.x + WING_HALF, z) > -0.4 ||
      shoreSDF(p.pos.x, z + 4.5) > -0.4
    ) {
      this.die('terrain');
      return;
    }

    // Player vs. entities.
    for (let i = this.ents.length - 1; i >= 0; i--) {
      const e = this.ents[i];

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

      if (e.kind === 'fuel') {
        this.fuel = Math.min(FUEL_MAX, this.fuel + FUEL_REFILL * dt);
      } else {
        this.die(e.kind);
        return;
      }
    }
  }

  bulletHits(b, e) {
    if (e.kind === 'bridge') {
      return (
        Math.abs(b.pos.z - e.pos.z) < 6 &&
        Math.abs(b.pos.x - e.pos.x) < e.halfWidth &&
        b.pos.y > 4 && b.pos.y < 11
      );
    }
    const dx = b.pos.x - e.pos.x;
    const dy = b.pos.y - e.pos.y;
    const dz = b.pos.z - e.pos.z;
    return dx * dx + dy * dy + dz * dz < (e.r + 1.4) ** 2;
  }

  destroy(e, index) {
    this.score += SPEC[e.kind].score;

    if (e.kind === 'bridge') {
      this.bridgesDown.add(e.sector);
      this.checkpointZ = e.pos.z + 45;
      this.spawnDebris(e.pos, 16, 40);
      this.kick(0.85, HITSTOP_BRIDGE);
    } else {
      this.spawnDebris(e.pos, 7, 24);
      this.kick(e.kind === 'jet' ? 0.4 : 0.3, HITSTOP_KILL);
    }

    this.remove(e);
    this.ents.splice(index, 1);
  }

  die(cause = 'unknown') {
    if (this.state !== 'playing') return;
    this.deaths.push({ cause, z: Math.round(this.player.pos.z), t: +this.time.toFixed(1) });
    this.state = 'dying';
    this.dyingT = DYING_TIME;
    this.spawnDebris(this.player.pos, 14, 30);
    this.kick(1, HITSTOP_DEATH);
  }

  afterDeath() {
    this.lives -= 1;
    if (this.lives <= 0) {
      this.state = 'gameover';
      return;
    }
    const z = this.checkpointZ;
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

    for (const d of this.debris) {
      d.mesh.position.lerpVectors(d.prevPos, d.pos, alpha);
      d.mesh.rotation.set(
        this.time * d.spin.x,
        this.time * d.spin.y,
        this.time * d.spin.z
      );
    }
  }

  /** Camera shake amplitude, 0..1, with the usual squared falloff. */
  get shake() {
    return this.trauma * this.trauma;
  }
}
