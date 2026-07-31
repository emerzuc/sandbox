import { gain, biquad, shaper, Smoothed } from './nodes.js';
import { engineWave, saturationCurve } from './buffers.js';
import { lerp } from '../core/math.js';

/**
 * Base partial in Hz — the audible tone sits an octave above, on oscBody. The
 * range is deliberately low: an engine is felt in the 60–200 Hz region and read
 * in the harmonics above it, and a bed that lives up at 400 Hz is a toy.
 */
const F_IDLE = 22;
const F_FULL = 52;

/**
 * The engine bed. This is the only sound the player hears continuously, for the
 * entire session, so the design constraint that dominates everything else is
 * *not fatiguing after ten minutes*.
 *
 * Two rules follow from that, and they explain most of the choices below.
 *
 * 1. No beating. Every oscillator is an exact integer multiple of one base
 *    partial (1×, 2×, 3×, 4×) driven from a single ConstantSourceNode, and the
 *    tremolo runs at a quarter of it. The whole bed is therefore one periodic
 *    waveform with a single fundamental. Detuned unison would sound fatter for
 *    thirty seconds and would be unbearable by minute three.
 * 2. Throttle changes timbre, not just pitch. Four independent expressions of
 *    load move together: the fundamental rises, the drive into the saturator
 *    rises (which manufactures harmonics), the 3rd-partial growl fades in, and
 *    the lowpass opens. A pitch-shifted sine does none of that and sounds like
 *    a hair dryer on a dimmer.
 *
 * On top of the tonal core sits the air: broadband wind whose highpass tracks
 * speed, an intake whine made from a resonant bandpass on noise rather than
 * from an oscillator (a sustained pure tone up at 2 kHz is the single most
 * fatiguing thing you can put in a game), and a low rumble.
 */
export class EngineBed {
  constructor(ctx, dest, noise) {
    this.ctx = ctx;
    this.sources = [];

    // The bed has no reverb send of its own: the caller taps it downstream of
    // the low-fuel duck, so ducking the bed ducks its share of the canyon too.
    this.out = gain(ctx, 0.34);
    this.out.connect(dest);

    // --- shared pitch control -------------------------------------------------
    // One node drives every oscillator's frequency through a per-partial
    // multiplier, so tracking speed costs a single parameter write per frame and
    // the partials can never drift out of ratio.
    this.f0 = ctx.createConstantSource();
    this.f0.offset.value = F_IDLE;
    this.sources.push(this.f0);

    // Two detune sources summed into one bus: the glide is written every frame
    // (throttle, spin-down on death) while the dip is scheduled by misfires.
    // Separate nodes because a scheduled ramp and a per-frame target on the same
    // AudioParam fight each other and the misfire loses.
    this.glide = ctx.createConstantSource();
    this.glide.offset.value = 0;
    this.dip = ctx.createConstantSource();
    this.dip.offset.value = 0;
    this.sources.push(this.glide, this.dip);
    this.detune = gain(ctx, 1);
    this.glide.connect(this.detune);
    this.dip.connect(this.detune);

    // --- tonal core -----------------------------------------------------------
    // Tuned so the saturator's input peaks just under 1.0 at full throttle:
    // any lower and the drive stage never bites, any higher and the WaveShaper's
    // domain clamp turns it into a hard clipper.
    this.mix = gain(ctx, 0.36);
    const body = engineWave(ctx, 20, 1.15, 1.0);
    const rasp = engineWave(ctx, 24, 0.72, 1.4);

    this.gSub = this.#osc(1, null, 0.34);
    this.gBody = this.#osc(2, body, 0.5);
    this.gGrowl = this.#osc(3, rasp, 0.05);
    this.gTop = this.#osc(4, body, 0.02);

    this.drive = gain(ctx, 1);
    this.sat = shaper(ctx, saturationCurve(2.4), '4x');
    this.post = gain(ctx, 1.6);
    // Fixed formants. The tone slides underneath them, which is what makes it
    // read as a machine bolted inside an airframe instead of a synth patch.
    this.form1 = biquad(ctx, 'peaking', 190, 1.1, 5);
    this.form2 = biquad(ctx, 'peaking', 640, 1.4, -4.5);
    this.lp = biquad(ctx, 'lowpass', 700, 0.9);

    // Blade thrum. At a quarter of the base partial the sidebands it creates
    // land on the same harmonic series, so it adds movement without roughness.
    this.am = gain(ctx, 1);
    this.amLfo = ctx.createOscillator();
    this.amLfo.frequency.value = 0;
    this.amDepth = gain(ctx, 0.05);
    const amMul = gain(ctx, 0.25);
    this.f0.connect(amMul);
    amMul.connect(this.amLfo.frequency);
    this.amLfo.connect(this.amDepth);
    this.amDepth.connect(this.am.gain);
    this.sources.push(this.amLfo);

    this.sputter = gain(ctx, 1);

    this.mix.connect(this.drive);
    this.drive.connect(this.sat);
    this.sat.connect(this.post);
    this.post.connect(this.form1);
    this.form1.connect(this.form2);
    this.form2.connect(this.lp);
    this.lp.connect(this.am);
    this.am.connect(this.sputter);
    this.sputter.connect(this.out);

    // --- air ------------------------------------------------------------------
    this.windSrc = this.#noise(noise, 1);
    this.airSrc = this.#noise(noise, 0.71); // decorrelated from the wind, so the
                                            // whine sits beside it rather than in it

    this.windHp = biquad(ctx, 'highpass', 320, 0.6);
    // Nothing above 7 kHz. Broadband hiss with the top left on is the other
    // classic way to make a bed that cannot be listened to for ten minutes.
    this.windLp = biquad(ctx, 'lowpass', 7000, 0.5);
    this.windG = gain(ctx, 0);
    this.windSrc.connect(this.windHp);
    this.windHp.connect(this.windLp);
    this.windLp.connect(this.windG);
    this.windG.connect(this.out);

    this.turbBp = biquad(ctx, 'bandpass', 1200, 6);
    this.turbG = gain(ctx, 0);
    this.airSrc.connect(this.turbBp);
    this.turbBp.connect(this.turbG);
    this.turbG.connect(this.out);

    this.rumbleLp = biquad(ctx, 'lowpass', 120, 0.9);
    this.rumbleG = gain(ctx, 0);
    this.windSrc.connect(this.rumbleLp);
    this.rumbleLp.connect(this.rumbleG);
    this.rumbleG.connect(this.out);

    // --- per-frame writers ----------------------------------------------------
    this.pF0 = new Smoothed(this.f0.offset, 0.09, 0.02);
    this.pGlide = new Smoothed(this.glide.offset, 0.12, 1.5);
    this.pDrive = new Smoothed(this.drive.gain, 0.1, 0.004);
    this.pPost = new Smoothed(this.post.gain, 0.1, 0.004);
    this.pLp = new Smoothed(this.lp.frequency, 0.1, 4);
    this.pGrowl = new Smoothed(this.gGrowl.gain, 0.12, 0.003);
    this.pTop = new Smoothed(this.gTop.gain, 0.12, 0.003);
    this.pAm = new Smoothed(this.amDepth.gain, 0.15, 0.002);
    this.pOut = new Smoothed(this.out.gain, 0.08, 0.003);
    this.pWindHp = new Smoothed(this.windHp.frequency, 0.14, 4);
    this.pWindG = new Smoothed(this.windG.gain, 0.1, 0.002);
    this.pTurbF = new Smoothed(this.turbBp.frequency, 0.14, 4);
    this.pTurbG = new Smoothed(this.turbG.gain, 0.12, 0.001);
    this.pRumbleG = new Smoothed(this.rumbleG.gain, 0.12, 0.002);
  }

  #osc(mult, wave, level) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave);
    else o.type = 'sine';
    o.frequency.value = 0; // driven entirely by the shared f0 node
    const m = gain(ctx, mult);
    this.f0.connect(m);
    m.connect(o.frequency);
    this.detune.connect(o.detune);
    const g = gain(ctx, level);
    o.connect(g);
    g.connect(this.mix);
    this.sources.push(o);
    return g;
  }

  #noise(buffer, rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = rate;
    this.sources.push(s);
    return s;
  }

  start(when) {
    for (const s of this.sources) s.start(when);
  }

  /**
   * @param speed01   throttle, already smoothed by the caller
   * @param alive     1 while flying, sliding to 0 while dead — drives the spin-down
   * @param low       0..1 low-fuel amount
   * @param windMod   0..1 terrain-seeded gust, a function of position not of time
   */
  update(now, speed01, alive, low, windMod) {
    const s = speed01;
    // Ceiling because an empty tank pushes the drive further: past ~5.2 the
    // saturator stops being a saturator and starts being a hard clipper.
    const drive = Math.min(lerp(1.0, 5.0, s * s) * (1 + 0.35 * low), 5.2);

    this.pF0.set(lerp(F_IDLE, F_FULL, Math.pow(s, 0.85)), now);
    this.pDrive.set(drive, now);
    // Partially undo the loudness the saturator adds. Partially: idle to full
    // still climbs about 6 dB, but the far bigger change is in timbre — energy
    // above the 6th harmonic goes from ~30% to ~42% across the same range.
    this.pPost.set(1.6 / (0.8 + 0.18 * drive), now);
    this.pLp.set(lerp(520, 2900, Math.pow(s, 0.7)) * lerp(1, 0.42, low), now);
    this.pGrowl.set(lerp(0.05, 0.42, s * s), now);
    this.pTop.set(lerp(0.02, 0.24, Math.pow(s, 1.6)), now);
    this.pAm.set(lerp(0.045, 0.09, s) + 0.11 * low, now);
    // Dying drops the whole series two octaves and takes the bed with it.
    this.pGlide.set((alive - 1) * 2800 - low * 55, now);
    this.pOut.set(0.34 * Math.pow(alive, 1.3), now);

    const windAmt = Math.pow(s, 1.5);
    this.pWindHp.set(lerp(280, 1250, s) * lerp(0.78, 1.3, windMod), now);
    this.pWindG.set((0.035 + 0.15 * windAmt) * (0.4 + 0.6 * alive), now);
    this.pTurbF.set(lerp(950, 2500, s), now);
    this.pTurbG.set((0.012 + 0.05 * s * s) * alive, now);
    this.pRumbleG.set((0.05 + 0.075 * s) * (0.45 + 0.55 * alive), now);
  }

  /**
   * A cylinder misses. Amplitude drops out for a few tens of milliseconds and
   * the pitch sags with it — a gain dip alone reads as a dropout in the audio
   * stream rather than as a mechanical fault.
   */
  misfire(now, depth) {
    const g = this.sputter.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1 - 0.8 * depth, now + 0.009);
    g.linearRampToValueAtTime(1, now + 0.06 + 0.06 * depth);

    const d = this.dip.offset;
    d.cancelScheduledValues(now);
    d.setValueAtTime(d.value, now);
    d.linearRampToValueAtTime(-260 * depth, now + 0.012);
    d.linearRampToValueAtTime(0, now + 0.13);
  }

  dispose(when) {
    for (const s of this.sources) {
      try { s.stop(when); } catch (_) { /* never started */ }
    }
    try { this.out.disconnect(); } catch (_) { /* best effort */ }
    this.sources.length = 0;
  }
}
