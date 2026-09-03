import * as THREE from 'three';
import { approach, damp, clamp01, invLerp } from '../core/math.js';

export const PLAYER_Y = 6;
export const WING_HALF = 5.2;

export const SPEED_MIN = 52;
export const SPEED_CRUISE = 80;
export const SPEED_MAX = 134;

const LAT_MAX = 48;
const LAT_ACCEL = 260;
const LAT_DECEL = 190;
const SPEED_ACCEL = 46;
export const MAX_ROLL = 0.62;

/**
 * Forward is +Z. Three's camera has local +X on the right of the screen and
 * looks down local -Z, so once it is turned around to face +Z, world +X lands
 * on the *left* of the screen. Rather than flip that everywhere, the input axis
 * is negated once, here, and the rest of the sim thinks in plain world X.
 */
const INPUT_TO_WORLD_X = -1;

export class Player {
  constructor() {
    this.pos = new THREE.Vector3(0, PLAYER_Y, 0);
    this.prevPos = this.pos.clone();
    this.vx = 0;
    this.speed = SPEED_CRUISE;
    this.roll = 0;
    this.prevRoll = 0;
    this.t = 0;
    this.fireCooldown = 0;
    this.invuln = 0;
  }

  reset(x, z) {
    this.pos.set(x, PLAYER_Y, z);
    this.prevPos.copy(this.pos);
    this.vx = 0;
    this.speed = SPEED_CRUISE;
    this.roll = 0;
    this.prevRoll = 0;
    this.fireCooldown = 0;
    this.invuln = 1.6;
  }

  /** 0 at minimum throttle, 1 at maximum. */
  get speed01() {
    return clamp01(invLerp(SPEED_MIN, SPEED_MAX, this.speed));
  }

  step(dt, input) {
    this.prevPos.copy(this.pos);
    this.prevRoll = this.roll;
    this.t += dt;

    const lat = input.lateral * INPUT_TO_WORLD_X;
    const rate = lat !== 0 ? LAT_ACCEL : LAT_DECEL;
    this.vx = approach(this.vx, lat * LAT_MAX, rate * dt);
    this.pos.x += this.vx * dt;

    const th = input.throttle;
    const target =
      th > 0 ? SPEED_MAX : th < 0 ? SPEED_MIN : SPEED_CRUISE;
    this.speed = approach(this.speed, target, SPEED_ACCEL * dt);
    this.pos.z += this.speed * dt;

    // Idle bob keeps the silhouette alive when the player is not inputting.
    this.pos.y = PLAYER_Y + Math.sin(this.t * 1.6) * 0.3;

    // Bank into the turn. Screen-space motion is -vx, hence the sign.
    this.roll = damp(this.roll, (-this.vx / LAT_MAX) * MAX_ROLL, 9, dt);

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.invuln = Math.max(0, this.invuln - dt);
  }
}
