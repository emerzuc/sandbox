import { gain, biquad, shaper, Smoothed } from './nodes.js';
import { noiseBuffer, saturationCurve, HW_MIN, HW_MAX } from './buffers.js';
import { CanyonReverb } from './reverb.js';
import { EngineBed } from './engine.js';
import { Sfx } from './sfx.js';
import { mulberry32, fbm1 } from '../core/rng.js';
import { clamp, clamp01, lerp, damp } from '../core/math.js';

/**
 * AUDIO — everything the game makes noise with.
 *
 * Wholly synthesised: not one byte of sample data ships with the build. The
 * river is a pure function of (x, z) and the soundtrack is a pure function of a
 * seed, for the same three reasons — nothing to author, nothing to load, and a
 * run that sounds the same twice.
 *
 * Two invariants hold everywhere below.
 *
 *   Never throw. A blocked or missing AudioContext must produce a silent game,
 *   not a broken one, so construction touches no Web Audio at all and every
 *   entry point is guarded. Audio is the one subsystem allowed to simply not
 *   exist.
 *
 *   update() allocates nothing. It runs every frame at 60–144 Hz; the only
 *   things it does are arithmetic and AudioParam writes that have already
 *   passed a dead-band (see Smoothed in nodes.js).
 */

const AUDIO_SEED = 0x5eed1e;

/** Below this fraction of a tank the whole mix starts changing. */
const LOW_FUEL = 0.3;

/** Master output once faded in. Headroom left deliberately: the limiter is a net, not a mixer. */
const OUT_LEVEL = 0.85;

/**
 * Engine variant c: rate of the slow wander, in value-noise cells per second
 * of *frame* time (so a paused tab does not jump it). Three octaves at 0.21
 * put movement at ~5 s, ~2.4 s and ~1.2 s — never periodic, never still.
 */
const DRIFT_RATE = 0.21;
/** Bank follows the stick at 10 Hz — the sim already damps roll at 9. */
const ROLL_LAMBDA = 10;

/** Fallback lub-dub spacing when the sim's beat cadence is not yet measurable. */
const BEAT_PERIOD_MIN = 0.3;
const BEAT_PERIOD_MAX = 1.2;

export class Audio {
  /** @param opts  { engine: 'a' | 'b' | 'c' } — bed variant, see ENGINE_TUNE in engine.js */
  constructor(opts) {
    // Nothing here may touch Web Audio: this runs at module scope, long before
    // the player has clicked anything.
    const engine = opts && opts.engine;
    this.engineVariant = engine === 'b' || engine === 'c' ? engine : 'a';
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.started = false;

    // Two independent streams so the mix's own jitter cannot be perturbed by
    // how many shots happened to be fired.
    this.rnd = mulberry32(AUDIO_SEED);
    this.jitter = mulberry32(AUDIO_SEED ^ 0x77);

    // Smoothed mix state, kept in JS because these values feed several params
    // each and because a spin-down has to survive a paused tab.
    this.speed = 0.34;
    this.aliveMix = 1;
    this.lowMix = 0;
    this.width = (HW_MIN + HW_MAX) * 0.5;
    this.roll = 0;
    this.driftT = 0;

    this.beatT = 0;
    this.lastBeat = -1;
    this.misfireT = 0;
    this.wasAlive = true;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Must be called from a real user gesture. Everything — the context, the
   * buffers, the graph — is built here rather than in the constructor, because
   * a context created outside a gesture starts suspended and some browsers log
   * or penalise it. Returns whether sound is actually running.
   */
  async resume() {
    if (this.failed || this.disposed) return false;
    try {
      if (!this.ctx) this.#build();
      if (!this.ctx) return false;
      if (this.ctx.state !== 'running') await this.ctx.resume();
      if (this.ctx.state !== 'running') return false;

      if (!this.started) {
        this.started = true;
        const t = this.ctx.currentTime + 0.02;
        this.engine.start(t);
        this.sfx.start(t);
        // Fade in. Starting a full engine bed at full level on the same frame
        // as the first keypress reads as a glitch, not as an engine.
        this.out.gain.cancelScheduledValues(t);
        this.out.gain.setValueAtTime(0.0001, t);
        this.out.gain.exponentialRampToValueAtTime(OUT_LEVEL, t + 0.6);
      }
      this.ready = true;
      return true;
    } catch (_) {
      this.failed = true;
      this.ready = false;
      return false;
    }
  }

  #build() {
    const Ctor = typeof window !== 'undefined'
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!Ctor) { this.failed = true; return; }

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // --- master chain -------------------------------------------------------
    this.master = gain(ctx, 1);
    // The engine's lowest partial reaches 22 Hz. Inaudible, but it still moves
    // speaker cones and steals headroom from everything that matters.
    this.dcHp = biquad(ctx, 'highpass', 26, 0.7);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -9;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.16;
    // The compressor has no lookahead, so the first millisecond of a transient
    // walks straight through it. This catches what it misses.
    //
    // The halve/curve/double sandwich makes the three nodes compute exactly
    // y = tanh(x): unity gain below about 0.5, a ceiling of 1.0, and the
    // WaveShaper's own domain clamp only reachable above 2.0 — so nothing
    // audible is ever hard-clipped, but nothing can leave here above full scale
    // either.
    this.clipPre = gain(ctx, 0.5);
    this.clip = shaper(ctx, saturationCurve(2), '2x');
    this.clipPost = gain(ctx, 2);
    this.out = gain(ctx, 0.0001);

    this.master.connect(this.dcHp);
    this.dcHp.connect(this.limiter);
    this.limiter.connect(this.clipPre);
    this.clipPre.connect(this.clip);
    this.clip.connect(this.clipPost);
    this.clipPost.connect(this.out);
    this.out.connect(ctx.destination);

    // --- buses --------------------------------------------------------------
    this.dry = gain(ctx, 1);
    this.dry.connect(this.master);

    this.reverb = new CanyonReverb(ctx, this.master, AUDIO_SEED ^ 0x1234);
    this.send = this.reverb.input;

    // The bed gets its own duck and tilt so low fuel can pull the world back
    // and make room for the heartbeat without touching the one-shots.
    this.bedIn = gain(ctx, 1);
    this.bedTilt = biquad(ctx, 'lowpass', 19000, 0.7);
    this.bedGain = gain(ctx, 1);
    this.bedSend = gain(ctx, 0.12);
    this.bedIn.connect(this.bedTilt);
    this.bedTilt.connect(this.bedGain);
    this.bedGain.connect(this.dry);
    this.bedGain.connect(this.bedSend);
    this.bedSend.connect(this.send);

    // --- sources ------------------------------------------------------------
    // Pink and long, with a folded seam so the wind never ticks. Two sources
    // read it at different rates downstream, so the true repeat is far longer
    // than the buffer.
    const bed = noiseBuffer(ctx, 3.3, AUDIO_SEED ^ 0xa11, true, 2, 0.35);
    // White, mono, short: one-shots read it at random offsets and rates.
    const burst = noiseBuffer(ctx, 1.7, AUDIO_SEED ^ 0xb22, false, 1, 0);

    this.engine = new EngineBed(ctx, this.bedIn, bed, this.engineVariant);
    this.sfx = new Sfx(ctx, this.dry, this.send, burst, this.rnd);

    this.pBed = new Smoothed(this.bedGain.gain, 0.25, 0.003);
    this.pTilt = new Smoothed(this.bedTilt.frequency, 0.25, 20);

    ctx.onstatechange = () => {
      this.ready = this.started && ctx.state === 'running';
    };
  }

  dispose() {
    this.disposed = true;
    this.ready = false;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      this.sfx.dispose(now);
      this.engine.dispose(now + 0.05);
      this.reverb.dispose();
      this.out.disconnect();
      this.ctx.close();
    } catch (_) { /* teardown is best effort */ }
    this.ctx = null;
  }

  // --------------------------------------------------------------------- frame

  /**
   * @param dt     frame seconds
   * @param state  { speed01, fuel01, canyonHalfWidth, alive, playerZ,
   *                 low01?, beat?, roll01? }
   *
   *   low01   0..1 tension, already damped by the sim. When present it *is*
   *           the low-fuel mix: the sim owns the clock so the HUD pulse and
   *           the heartbeat can share it. Absent, the old fuel01-derived ramp
   *           runs as before.
   *   beat    true on the frame a heartbeat fires. Only read when low01 is
   *           present; otherwise the internal timer beats.
   *   roll01  -1..1 bank, positive = right wing down. Engine variant c only.
   */
  update(dt, state) {
    if (!this.ready || !state) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    // A tab that was hidden for a minute hands back an enormous dt; clamping it
    // is the difference between a smooth return and an audible lurch.
    const d = dt > 0.1 ? 0.1 : dt > 0 ? dt : 0.016;

    const speed01 = clamp01(+state.speed01 || 0);
    const fuel01 = clamp01(state.fuel01 === undefined ? 1 : +state.fuel01 || 0);
    const alive = state.alive === undefined ? true : !!state.alive;
    const hw = clamp(+state.canyonHalfWidth || 30, HW_MIN - 4, HW_MAX + 4);
    const z = +state.playerZ || 0;
    const roll01 = clamp(+state.roll01 || 0, -1, 1);
    const simClock = state.low01 !== undefined;

    this.speed = damp(this.speed, speed01, 6, d);
    this.width = damp(this.width, hw, 3, d);
    this.roll = damp(this.roll, roll01, ROLL_LAMBDA, d);
    // Asymmetric: the engine dies faster than it comes back, which is what
    // respawning is supposed to feel like.
    this.aliveMix = damp(this.aliveMix, alive ? 1 : 0, alive ? 2.4 : 3.6, d);

    if (simClock) {
      // The sim's value arrives damped and, at the 30% crossing, stepped
      // straight to ~0.35. Taken as-is: every param downstream sits behind a
      // Smoothed with its own tau, so the step is a quick swell, not a click,
      // and smoothing it again here would only make the warning late — which
      // is the very thing the step was introduced to fix.
      this.lowMix = clamp01(+state.low01 || 0);
    } else {
      const lowTarget = alive ? clamp01((LOW_FUEL - fuel01) / LOW_FUEL) : 0;
      this.lowMix = damp(this.lowMix, lowTarget, 1.8, d);
    }

    // Gusts are a function of *where the plane is*, not of when: same stretch
    // of river, same air. Two octaves is all this needs and it costs four hashes.
    const windMod = fbm1(z * 0.0021, AUDIO_SEED, 2);
    // Drift is the opposite: a function of when, not where, so the bed keeps
    // moving even when the plane hovers on a straight. Seeded, so it too is
    // the same on every run. Cheap enough to compute for every variant; only
    // c listens.
    this.driftT += d;
    const drift = fbm1(this.driftT * DRIFT_RATE, AUDIO_SEED ^ 0xd41f7, 3);

    this.engine.update(now, this.speed, this.aliveMix, this.lowMix, windMod, this.roll, drift);

    // The bed steps back and goes dull as the tank empties. This is the point of
    // the whole low-fuel treatment: the tension is not a beep on top of the mix,
    // it is the mix changing shape.
    this.pBed.set(1 - 0.42 * this.lowMix, now);
    this.pTilt.set(lerp(19000, 1500, this.lowMix), now);

    // A tight gorge throws more back at you; a wide one lets it escape. Layered
    // on top of the bucketed IR, this is what keeps the change continuous.
    const widthT = clamp01((this.width - HW_MIN) / (HW_MAX - HW_MIN));
    this.reverb.update(now, this.width, lerp(0.4, 0.24, widthT) + 0.1 * this.lowMix);
    this.reverb.prewarm();

    this.sfx.fuel01 = fuel01;
    this.sfx.tick(now, d);
    this.#tension(now, d, simClock, simClock && !!state.beat);

    // Everything below the explosion tier belongs to a plane that no longer
    // exists — shots in flight, the refuel blip, the heartbeat. Cut those; leave
    // the death and bridge voices ringing.
    if (this.wasAlive && !alive) this.sfx.silence(now, 0.12, 2);
    this.wasAlive = alive;
  }

  /**
   * Heartbeat and misfires. Timers only — no nodes are built unless one fires.
   *
   * `simClock` means the simulation owns the heartbeat: it fires on `beat`, so
   * the HUD's edge pulse and the lub-dub are the same event. Misfires are the
   * engine's business and stay on the internal jittered timer either way.
   */
  #tension(now, dt, simClock, beat) {
    if (this.lowMix < 0.04 || this.aliveMix < 0.5) {
      this.beatT = 0;
      this.lastBeat = -1;
      this.misfireT = 0;
      return;
    }

    const level = 0.35 + 0.65 * this.lowMix;
    if (simClock) {
      if (beat) {
        // The lub-dub gap follows the measured cadence, so a sim that speeds
        // the heart up gets a tighter second beat without telling us its BPM.
        const period = this.lastBeat >= 0
          ? clamp(now - this.lastBeat, BEAT_PERIOD_MIN, BEAT_PERIOD_MAX)
          : 60 / lerp(56, 150, this.lowMix);
        this.lastBeat = now;
        this.sfx.heartbeat(now, level, period);
      }
    } else {
      const period = 60 / lerp(56, 150, this.lowMix);
      this.beatT -= dt;
      if (this.beatT <= 0) {
        this.beatT = period;
        this.sfx.heartbeat(now, level, period);
      }
    }

    this.misfireT -= dt;
    if (this.misfireT <= 0) {
      // Jittered from the audio PRNG, never Math.random: a run has to sound the
      // same twice even though nothing here touches the simulation.
      this.misfireT = lerp(1.5, 0.18, this.lowMix) * (0.6 + this.jitter() * 0.8);
      this.engine.misfire(now, this.lowMix);
    }
  }

  // -------------------------------------------------------------------- events

  /**
   * @param name  'shot' | 'explosion' | 'bridge' | 'death' | 'refuel' | 'lowfuel' | 'nearmiss' | 'scrape'
   * @param opts  optional { pan: -1..1, gain: number, cause: string }
   *
   * 'refuel' and 'scrape' are per-frame events: fire them every frame the
   * condition holds and they pump one persistent voice each. 'lowfuel' may be
   * fired on a cadence; the sting rate-limits itself.
   */
  event(name, opts) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const pan = opts && opts.pan !== undefined ? clamp(+opts.pan || 0, -1, 1) : 0;
    const level = opts && opts.gain !== undefined ? clamp(+opts.gain || 0, 0, 2) : 1;

    try {
      switch (name) {
        case 'shot': this.sfx.shot(now, level); break;
        case 'explosion': this.sfx.explosion(now, level, pan, false); break;
        case 'bridge': this.sfx.bridge(now, level, pan); break;
        case 'death': this.sfx.death(now, opts && opts.cause); break;
        case 'refuel': this.sfx.refuel(now, level); break;
        case 'lowfuel': this.sfx.alarm(now, level); break;
        case 'nearmiss': this.sfx.nearmiss(now, level, pan); break;
        case 'scrape': this.sfx.scrape(now, level, pan); break;
        default: break; // an unknown name is the caller's bug, not a crash
      }
    } catch (_) { /* a dropped sound must never take the frame with it */ }
  }
}
