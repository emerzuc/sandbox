import { mulberry32 } from '../core/rng.js';
import { clamp01, lerp } from '../core/math.js';

/**
 * Every sample this game plays is computed here. No files, no CDN, no decode
 * step — the build stays one JS bundle, and the sound is a function of a seed
 * exactly like the river is a function of (x, z).
 *
 * Everything in this module runs once, at resume() time. None of it is allowed
 * anywhere near the per-frame path.
 */

/** World units to metres. A 13-unit wingspan is meant to read as a ~10 m fighter. */
const UNIT_M = 0.77;
const C_AIR = 343;

/**
 * Looping noise bed.
 *
 * `seam` folds an extra tail of noise back over the head with an equal-power
 * crossfade, so the loop point has neither a click nor the 3 dB dip a linear
 * crossfade would leave. Without it a 4-second wind loop ticks once per bar and
 * the ear locks onto it within a minute — which is exactly the fatigue this
 * whole layer is supposed to avoid.
 *
 * `pink` runs Kellet's filter bank over the white source. Pink is the right
 * spectrum for wind and for explosion tails: white noise is all treble and is
 * unlistenable for ten minutes.
 */
export function noiseBuffer(ctx, seconds, seed, pink = false, channels = 2, seam = 0) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(seconds * sr));
  const fade = Math.min(Math.round(seam * sr), (n / 2) | 0);
  const buf = ctx.createBuffer(channels, n, sr);
  const rnd = mulberry32(seed >>> 0);
  const tail = fade > 0 ? new Float32Array(fade) : null;

  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

    for (let i = 0, total = n + fade; i < total; i++) {
      const w = rnd() * 2 - 1;
      let s = w;
      if (pink) {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        // 0.11 puts the sum back at roughly unit peak; the filter bank has ~9 dB
        // of gain built into it.
        s = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      if (i < n) d[i] = s;
      else tail[i - n] = s;
    }

    for (let i = 0; i < fade; i++) {
      const t = (i / fade) * Math.PI * 0.5;
      // tail[i] is the true continuation of d[n-1], so it owns the seam and
      // hands over to the buffer's own head across the fade.
      d[i] = d[i] * Math.sin(t) + tail[i] * Math.cos(t);
    }
  }
  return buf;
}

/**
 * Soft-clip transfer curve, y = tanh(k·x)/k over x in [-1, 1].
 *
 * Unity slope at the origin and a ceiling of 1/k, so pairing it with a makeup
 * gain of k gives a shaper that is transparent on quiet material and hard-
 * ceilinged on loud material. Used twice: as the master safety net after the
 * limiter, and as the engine's drive stage, where the *amount* pushed into it
 * is what turns throttle into audible load.
 */
export function saturationCurve(k, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / k;
  }
  return c;
}

/**
 * Harmonic series for the engine oscillators. `tilt` sets how fast partials
 * fall away (low tilt = brassy and rich), `oddBias` weights odd partials, which
 * is what separates a hollow reed-like tone from a full one.
 */
export function engineWave(ctx, harmonics, tilt, oddBias) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let h = 1; h <= harmonics; h++) {
    let a = Math.pow(h, -tilt);
    if (h % 2 === 1) a *= oddBias;
    imag[h] = a;
  }
  return ctx.createPeriodicWave(real, imag);
}

// --------------------------------------------------------------- canyon reverb

/** Half-widths (world units) the river actually produces; see world/river.js. */
export const HW_MIN = 21;
export const HW_MAX = 38;

/** Time from the plane to a gorge wall and back, in seconds. */
export function wallDelay(halfWidth) {
  return (2 * halfWidth * UNIT_M) / C_AIR;
}

/**
 * Procedural canyon impulse response.
 *
 * Two walls, close together, open sky above. That means a short run of discrete
 * slapback reflections at the wall spacing — the thing that makes a gorge sound
 * like a gorge — sitting on top of a diffuse tail that gets darker as it decays,
 * because air and rock eat treble first.
 *
 * A tight gorge gets closely spaced, brighter, shorter reverb; a wide one gets
 * spaced-out, darker, longer reverb. Nobody will consciously hear this. Everyone
 * will feel the walls close in.
 *
 * Energy-normalised (sum of squares = 1 per channel) so the convolver runs with
 * normalize = false and swapping one IR for another is a timbre change and not a
 * level jump — which is what makes crossfading between buckets invisible.
 */
export function canyonIR(ctx, halfWidth, seed) {
  const sr = ctx.sampleRate;
  const t = clamp01((halfWidth - HW_MIN) / (HW_MAX - HW_MIN));

  const spacing = wallDelay(halfWidth);
  const rt = lerp(0.95, 1.85, t);
  const len = Math.max(64, Math.round(rt * sr));
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = mulberry32(seed >>> 0);

  // -60 dB at rt, i.e. the textbook RT60.
  const decayK = Math.log(1000) / rt;
  // Tail brightness: a tight gorge rings higher. These are one-pole
  // coefficients, not Hz — a is roughly 2*pi*fc/sr for small a.
  const aStart = lerp(0.62, 0.44, t);
  const aEnd = lerp(0.16, 0.09, t);

  // Recurrences instead of a Math.exp per sample. This loop runs ~180k times
  // per IR and prewarm() spends it inside a frame, so the difference between
  // the closed form and the recurrence is the difference between a dropped
  // frame and no dropped frame.
  const envStep = Math.exp(-decayK / sr);
  const buildStep = 1 - Math.exp(-1 / (0.014 * sr));
  const aStep = (aEnd - aStart) / len;

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let env = 1;
    // Reverb does not exist at t=0; it densifies. Skipping the build-up is
    // what makes cheap IRs sound like a burst of static.
    let build = 0;
    let a = aStart;
    for (let i = 0; i < len; i++) {
      lp += a * ((rnd() * 2 - 1) - lp);
      d[i] = lp * env * build;
      env *= envStep;
      build += (1 - build) * buildStep;
      a += aStep;
    }
  }

  // Early reflections. Alternating walls: each bounce is louder in the opposite
  // channel, which is why a canyon reads as *width* and not as a bigger room.
  const burst = Math.max(8, Math.round(0.0022 * sr));
  for (let k = 0; k < 8; k++) {
    const at = spacing * k * (1 + (rnd() - 0.5) * 0.16);
    if (at >= rt * 0.72) break;
    const start = Math.round(at * sr);
    const amp = Math.pow(0.60, k) * 0.9 * lerp(1.15, 0.85, t);
    const near = k % 2;
    // Later bounces have hit more rock, so they arrive duller.
    const a = lerp(0.75, 0.2, clamp01(k / 6));

    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const w = c === near ? 1 : 0.45;
      let lp = 0;
      for (let j = 0; j < burst && start + j < len; j++) {
        lp += a * ((rnd() * 2 - 1) - lp);
        // Half-cosine window: an unwindowed tap is a click, not a reflection.
        const win = 0.5 - 0.5 * Math.cos((j / burst) * Math.PI * 2);
        d[start + j] += lp * win * amp * w;
      }
    }
  }

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let sum = 0;
    for (let i = 0; i < len; i++) sum += d[i] * d[i];
    const g = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    for (let i = 0; i < len; i++) d[i] *= g;
  }
  return buf;
}
