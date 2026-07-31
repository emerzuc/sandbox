/**
 * Graph-building ergonomics. Web Audio's constructors are three lines of
 * ceremony each, which buries the signal flow under boilerplate; these wrappers
 * exist so the chains in engine.js and sfx.js read top-to-bottom as audio.
 */

export function gain(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

export function biquad(ctx, type, freq, q = 1, gainDb = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function shaper(ctx, curve, oversample = '2x') {
  const w = ctx.createWaveShaper();
  w.curve = curve;
  w.oversample = oversample;
  return w;
}

/**
 * A per-frame writer for an AudioParam.
 *
 * Two problems it solves. Assigning `.value` every frame steps the parameter at
 * frame rate, which zippers audibly on gains and cutoffs; and re-scheduling a
 * parameter that has not meaningfully moved is pure waste when update() runs at
 * 144 Hz. So: dead-band first, then hand the browser a smooth target to glide
 * to. Allocation-free — the object is built once at graph time.
 */
export class Smoothed {
  constructor(param, tau = 0.06, eps = 1e-4) {
    this.param = param;
    this.tau = Math.max(tau, 0.002);
    this.eps = eps;
    this.last = param.value;
  }

  set(v, now) {
    // A NaN reaching an AudioParam poisons the node permanently, and the only
    // symptom is silence. The sim can hand us a NaN speed for one frame after a
    // reset; refusing it here is cheaper than hunting it later.
    if (!(v === v)) return;
    if (v - this.last < this.eps && this.last - v < this.eps) return;
    this.last = v;
    this.param.setTargetAtTime(v, now, this.tau);
  }
}

/** exponentialRamp cannot touch zero; this is the practical floor. */
export const SILENT = 0.0001;

/**
 * Percussive envelope. Exponential in both directions because that is what ears
 * read as "a thing was struck" — a linear decay sounds like a fade-out.
 */
export function ping(param, now, peak, attack, decay) {
  const p = Math.max(peak, SILENT * 2);
  param.setValueAtTime(SILENT, now);
  param.exponentialRampToValueAtTime(p, now + attack);
  param.exponentialRampToValueAtTime(SILENT, now + attack + decay);
}

/** Frequency glide. Exponential so equal ratios take equal time, as pitch is heard. */
export function sweep(param, now, from, to, time, delay = 0) {
  param.setValueAtTime(Math.max(from, 1), now + delay);
  param.exponentialRampToValueAtTime(Math.max(to, 1), now + delay + time);
}
