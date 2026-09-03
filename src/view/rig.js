import * as THREE from 'three';
import { damp, lerp, clamp01 } from '../core/math.js';
import { valueNoise1 } from '../core/rng.js';

// Raised and pulled in after the playtest: the original is a top-down game, and
// lateral position is what a chase camera hides. A few units of height buys
// back some of the plan view without giving up the box-art horizon.
const BACK = 25.5;
const UP = 15.5;
const LOOK_AHEAD = 46;

const FOV_BASE = 60;
const FOV_KICK = 11;

const SHAKE_POS = 1.5;
const SHAKE_ROT = 0.035;

/**
 * Chase camera. Everything here runs on frame time (not the fixed sim step) and
 * uses exponential damping, so it behaves identically at 60 and 144 Hz.
 *
 * Three separate lags do the work: the rig lags the plane, the look target lags
 * the rig, and the FOV lags the throttle. Together they turn a translation into
 * a sense of mass.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, UP, -BACK);
    this.look = new THREE.Vector3(0, 0, LOOK_AHEAD);
    this.fov = FOV_BASE;
    this._tp = new THREE.Vector3();
    this._tl = new THREE.Vector3();
  }

  update(dt, game) {
    const p = game.player;
    const rp = game.planeMesh.position;

    // Trail slightly to the outside of the turn, and lead the look target so
    // the player sees where they are going before they get there.
    this._tp.set(rp.x + p.vx * 0.13, rp.y + UP, rp.z - BACK);
    this._tl.set(rp.x + p.vx * 0.34, rp.y + 1.5, rp.z + LOOK_AHEAD);

    // A respawn teleports the player backwards; snap instead of sweeping the
    // camera across half a kilometre of terrain.
    if (this.pos.distanceToSquared(this._tp) > 200 * 200) {
      this.pos.copy(this._tp);
      this.look.copy(this._tl);
    }

    this.pos.x = damp(this.pos.x, this._tp.x, 7.5, dt);
    this.pos.y = damp(this.pos.y, this._tp.y, 6.0, dt);
    this.pos.z = damp(this.pos.z, this._tp.z, 12.0, dt);

    this.look.x = damp(this.look.x, this._tl.x, 5.5, dt);
    this.look.y = damp(this.look.y, this._tl.y, 5.0, dt);
    this.look.z = damp(this.look.z, this._tl.z, 12.0, dt);

    const shake = game.shake;
    const t = game.time;
    // Deterministic noise, not Math.random: a given seed must always produce
    // the same frame, shake included, or screenshot regression is worthless.
    const nx = (valueNoise1(t * 47, 11) - 0.5) * 2;
    const ny = (valueNoise1(t * 41, 29) - 0.5) * 2;
    const nr = (valueNoise1(t * 37, 53) - 0.5) * 2;

    this.camera.position.set(
      this.pos.x + nx * shake * SHAKE_POS,
      this.pos.y + ny * shake * SHAKE_POS,
      this.pos.z
    );
    this.camera.lookAt(this.look);

    const roll = game.planeMesh.rotation.z;
    this.camera.rotateZ(roll * 0.28 + nr * shake * SHAKE_ROT);

    const targetFov = FOV_BASE + p.speed01 * FOV_KICK + shake * 4;
    this.fov = damp(this.fov, targetFov, 5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
