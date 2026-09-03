import { riverCenterX, riverHalfWidth, islandAt } from '../world/river.js';
import { clamp } from './math.js';

/**
 * Stands in for the Input interface and flies the river on its own.
 *
 * This is not a gameplay feature — it is the test harness. A deterministic
 * pilot means a run is reproducible frame for frame, which is what makes
 * screenshot regression and headless perf benchmarking possible. It also
 * doubles as a continuous assertion that the world is *survivable*: if a pilot
 * that knows the exact position of every hazard cannot get through a stretch,
 * no human could either, and that is a level-generation bug worth failing on.
 */

const LOOK = 70;

// Must match player.js.
const LAT_MAX = 48;
const LAT_DECEL = 190;
const WING_HALF = 5.2;
const PLAYER_R = 3.2;

const AVOID_RANGE = 150;
const SHOT_CLEARANCE = 11; // hostile shot radius + plane radius + slack
const FUEL_SEEK_BELOW = 92; // top up opportunistically, the way a human would
const FUEL_SEEK_RANGE = 620;

/** The navigable corridors at z: one, or two when an island splits the river. */
function lanesAt(z) {
  const cx = riverCenterX(z);
  const hw = riverHalfWidth(z);
  const isl = islandAt(z);
  if (isl.amt <= 0.001) return [{ lo: cx - hw, hi: cx + hw }];

  const ihw = isl.hw * isl.amt;
  const icx = cx + isl.off;
  return [
    { lo: cx - hw, hi: icx - ihw },
    { lo: icx + ihw, hi: cx + hw },
  ];
}

const mid = (l) => (l.lo + l.hi) / 2;

/** Clamp a committed lane index against however many lanes exist here. */
function pickLane(lanes, idx) {
  return lanes[Math.min(Math.max(idx, 0), lanes.length - 1)];
}

export class Autopilot {
  constructor(game) {
    this.game = game;
    this._lat = 0;
    this.lane = -1; // -1 = uncommitted
    this._threat = new Float64Array(32);
  }

  update() {
    const p = this.game.player;
    const here = lanesAt(p.pos.z);
    const there = lanesAt(p.pos.z + LOOK);

    // Commit on the *horizon*, not on the current position. An island fades in
    // from zero width, so by the time it exists underneath the plane, the plane
    // is already standing on it — the choice has to be made while the water
    // below is still open.
    if (here.length === 1 && there.length === 1) {
      this.lane = -1;
    } else if (this.lane < 0) {
      const options = there.length > 1 ? there : here;
      this.lane =
        Math.abs(mid(options[0]) - p.pos.x) <= Math.abs(mid(options[1]) - p.pos.x) ? 0 : 1;
    }

    // Where to be right now: the committed corridor — or, if the split has not
    // opened here yet, the still-open channel restricted to the side we are
    // committed to. That moves the plane across early, with no target jump when
    // the island finally appears underneath it.
    let lane;
    if (here.length === 1 && there.length > 1) {
      const aim = pickLane(there, this.lane);
      const lo = Math.max(aim.lo, here[0].lo);
      const hi = Math.min(aim.hi, here[0].hi);
      // On a bend the corridor ahead can sit entirely outside the channel we
      // are in right now, which inverts the intersection. Falling through to
      // the open channel keeps the target in water; the feed-forward still
      // pulls us toward the correct side.
      lane = hi - lo > 2 * WING_HALF + 4 ? { lo, hi } : here[0];
    } else {
      lane = pickLane(here, this.lane);
    }

    let target = mid(lane);

    // Steer to a fuel depot when the tank is getting low, if it is reachable
    // inside the corridor we are already committed to.
    if (this.game.fuel < FUEL_SEEK_BELOW) {
      let best = null;
      let bestDz = Infinity;
      for (const e of this.game.ents) {
        if (e.kind !== 'fuel') continue;
        const dz = e.pos.z - p.pos.z;
        if (dz < 8 || dz > FUEL_SEEK_RANGE || dz > bestDz) continue;
        if (e.pos.x < lane.lo || e.pos.x > lane.hi) continue;
        if (Math.abs(e.pos.x - p.pos.x) > dz * 0.5) continue; // unreachable in time
        best = e;
        bestDz = dz;
      }
      if (best) target = best.pos.x;
    }

    // Sidestep hostiles. The push is proportional to the clearance we are
    // *missing*, so it fades to nothing once we are clear instead of shoving at
    // full strength regardless — which used to fling the plane into the far bank.
    let bias = 0;
    for (const e of this.game.ents) {
      if (e.kind === 'fuel' || e.kind === 'bridge') continue;
      const dz = e.pos.z - p.pos.z;
      if (dz < 4 || dz > AVOID_RANGE) continue;
      const dx = e.pos.x - target;
      const need = e.r + PLAYER_R + 4;
      if (Math.abs(dx) >= need) continue;
      bias -= Math.sign(dx || 1) * (need - Math.abs(dx)) * (1 - dz / AVOID_RANGE) * 1.6;
    }

    // Incoming fire. Project each hostile shot to where it will be when the
    // plane reaches its z — a shell crossing the river laterally and a burst
    // aimed at a predicted position are both straight lines, so this is exact —
    // and step out of the way in proportion to how close it will pass. Any
    // lateral movement defeats a lead-aimed shot, which is the whole point of
    // the tell: this is what a human does when the turret comes round.
    //
    // Summing per-shot pushes fails on a burst: three shells spread across the
    // lane push left, right and nowhere, and the sum flies straight into the
    // middle one. So instead of pushing, *search*: try a handful of lateral
    // positions and take the one that keeps the most distance from every shell
    // that will meet us, with a slight preference for staying put.
    let n = 0;
    for (const s of this.game.shots) {
      const dz = s.pos.z - p.pos.z;
      if (dz < -40 || dz > 200) continue;
      // Meet time from the relative z velocity, whatever its sign: a shell
      // fired from abreast with forward lead is *slower* than the plane and
      // gets overtaken — a bank-side gun's favourite kill — while a burst from
      // ahead closes fast. Only a meeting in the near future matters.
      const closing = p.speed - s.vel.z;
      if (Math.abs(closing) < 4) continue;
      const t = dz / closing;
      if (t < 0 || t > 2.5) continue;
      if (n < this._threat.length) this._threat[n++] = s.pos.x + s.vel.x * t;
    }
    if (n > 0) {
      const base = target + bias;
      let bestX = base;
      let bestScore = -Infinity;
      for (let k = -5; k <= 5; k++) {
        const cand = base + k * 3.2;
        if (cand < lane.lo + WING_HALF + 2 || cand > lane.hi - WING_HALF - 2) continue;
        let gap = Infinity;
        for (let i = 0; i < n; i++) gap = Math.min(gap, Math.abs(this._threat[i] - cand));
        const score = Math.min(gap, SHOT_CLEARANCE * 1.5) - Math.abs(k) * 0.35;
        if (score > bestScore) { bestScore = score; bestX = cand; }
      }
      bias = bestX - target;
    }

    // Never aim closer to a shore than the wingtips plus slack.
    const margin = Math.min(WING_HALF + 5, (lane.hi - lane.lo) / 2 - 1);
    target = clamp(target + bias, lane.lo + margin, lane.hi - margin);

    // The corridor itself is moving downstream. Feeding the lookahead into the
    // position target would leave a permanent steady-state offset of
    // slope * LOOK — most of the clearance in a tight channel. Feed it into
    // velocity instead.
    const feedForward = ((mid(pickLane(there, this.lane)) - mid(lane)) / LOOK) * p.speed;

    // Approach speed capped by what we can still brake out of before reaching
    // the target, at 55% of available deceleration. A plain proportional law
    // arrives at full lateral speed and overshoots by v²/2a — six units, which
    // is most of the clearance in a tight channel.
    const err = target - p.pos.x;
    const brake = Math.sqrt(2 * LAT_DECEL * 0.55 * Math.abs(err));
    const wantVx = Math.sign(err) * Math.min(LAT_MAX, brake) + feedForward;

    // Flip to the input axis (see player.js).
    this._lat = -clamp(wantVx / LAT_MAX, -1, 1);
  }

  get lateral() { return this._lat; }
  get throttle() { return 0; }
  get firing() { return true; }
  consumeFire() { return false; }
  consumeRestart() { return false; }
}
