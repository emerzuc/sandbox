import { gain, biquad, Smoothed } from './nodes.js';
import { canyonIR, wallDelay, HW_MIN, HW_MAX } from './buffers.js';
import { clamp, clamp01 } from '../core/math.js';

/** Impulse responses are expensive; four buckets across the river's range is plenty. */
const BUCKETS = 4;
const XFADE = 0.9;
/** Hysteresis in bucket units — stops a river that hovers on a boundary from chattering. */
const SNAP = 0.62;

/**
 * The canyon.
 *
 * Two convolvers, one audible at a time, crossfaded when the gorge changes
 * bucket. Regenerating an IR per frame is out of the question (millions of ops),
 * so the *bucketed* part of the sound — internal reflection spacing, decay
 * length, tail colour — is baked, and the part the ear tracks continuously —
 * the delay to the first wall — rides a DelayNode that follows the true half
 * width every frame. Result: a stepped IR the player cannot hear stepping,
 * under a continuous slapback they can.
 */
export class CanyonReverb {
  constructor(ctx, dest, seed) {
    this.ctx = ctx;
    this.seed = seed >>> 0;
    this.irs = new Array(BUCKETS).fill(null);
    this.bucket = -1;
    this.want = 0;
    this.slot = 0;

    this.input = gain(ctx, 1);
    // Nothing below ~180 Hz should go into the tail: low end in a reverb is
    // just mud, and the engine bed already owns that register.
    this.hp = biquad(ctx, 'highpass', 180, 0.7);
    this.pre = ctx.createDelay(0.5);
    this.pre.delayTime.value = wallDelay(30);

    this.conv = [ctx.createConvolver(), ctx.createConvolver()];
    this.mix = [gain(ctx, 1), gain(ctx, 0)];
    this.out = gain(ctx, 0.3);

    this.input.connect(this.hp);
    this.hp.connect(this.pre);
    for (let i = 0; i < 2; i++) {
      this.conv[i].normalize = false; // IRs are energy-matched in buffers.js
      this.pre.connect(this.conv[i]);
      this.conv[i].connect(this.mix[i]);
      this.mix[i].connect(this.out);
    }
    this.out.connect(dest);

    // Slow: this delay is swept live, and a fast sweep is an audible pitch bend.
    this.pDelay = new Smoothed(this.pre.delayTime, 0.45, 0.0004);
    this.pWet = new Smoothed(this.out.gain, 0.5, 0.002);
  }

  /**
   * Build at most one missing IR, nearest-needed first. An IR costs a few
   * milliseconds; four of them at once would be a visible stall, so they are
   * spread one per frame and the room simply arrives a few frames late — which
   * nobody has ever noticed in the history of games.
   */
  prewarm() {
    if (!this.irs[this.want]) return this.#make(this.want);
    for (let i = 0; i < BUCKETS; i++) if (!this.irs[i]) return this.#make(i);
    return false;
  }

  #make(i) {
    this.irs[i] = canyonIR(this.ctx, this.#width(i), this.seed + i * 7919);
    return true;
  }

  #width(i) {
    return HW_MIN + ((HW_MAX - HW_MIN) * i) / (BUCKETS - 1);
  }

  /**
   * `halfWidth` is the river's half-width at the plane, in world units.
   * `wet` is the send level, driven by the caller so tension can push it around.
   */
  update(now, halfWidth, wet) {
    const hw = clamp(halfWidth, HW_MIN - 4, HW_MAX + 4);
    this.pDelay.set(wallDelay(hw), now);
    this.pWet.set(wet, now);

    const u = clamp01((hw - HW_MIN) / (HW_MAX - HW_MIN)) * (BUCKETS - 1);
    const want = Math.round(u);
    this.want = want;
    if (want === this.bucket) return;
    if (this.bucket >= 0 && Math.abs(u - this.bucket) < SNAP) return;
    // Never build here: this runs inside the frame. prewarm() owns that budget,
    // and it will have this bucket ready within a frame or two.
    if (!this.irs[want]) return;
    this.#swap(now, want);
  }

  #swap(now, bucket) {
    this.bucket = bucket;
    const next = this.slot ^ 1;
    // Safe to reassign: this convolver is currently silent, so the discontinuity
    // in its tail is multiplied by a gain of zero.
    this.conv[next].buffer = this.irs[bucket];

    const rise = this.mix[next].gain;
    const fall = this.mix[this.slot].gain;
    rise.cancelScheduledValues(now);
    fall.cancelScheduledValues(now);
    rise.setValueAtTime(rise.value, now);
    fall.setValueAtTime(fall.value, now);
    // Equal power in eight segments. The two tails are decorrelated noise, so a
    // straight linear crossfade would dip 3 dB in the middle — audible as the
    // room briefly vanishing every time the gorge changes width.
    for (let i = 1; i <= 8; i++) {
      const t = (i / 8) * Math.PI * 0.5;
      rise.linearRampToValueAtTime(Math.sin(t), now + (i / 8) * XFADE);
      fall.linearRampToValueAtTime(Math.cos(t), now + (i / 8) * XFADE);
    }
    this.slot = next;
  }

  dispose() {
    try {
      this.input.disconnect();
      this.out.disconnect();
      for (let i = 0; i < 2; i++) {
        this.conv[i].disconnect();
        this.conv[i].buffer = null;
      }
    } catch (_) { /* teardown is best effort */ }
    this.irs.length = 0;
  }
}
