import { gain, biquad, ping, sweep, Smoothed, SILENT } from './nodes.js';
import { clamp, clamp01, lerp } from '../core/math.js';

/**
 * One-shots, and the voice budget that keeps them from eating the machine.
 *
 * The game fires nine shots a second and can drop a bridge into the middle of
 * that, so two things matter more than the synthesis: the node graph must be
 * bounded, and no two instances of the same sound may be identical. Five
 * explosions that are the same explosion five times is the single most obvious
 * tell that a game's audio was an afterthought.
 *
 * Variation comes from a seeded PRNG handed in by the caller, never from
 * Math.random(). Audio does not touch game state, but a run that sounds
 * different every time is a run whose recordings cannot be diffed either.
 */

/** Total concurrent voices. Beyond this something has to give. */
const CAP = 22;

/**
 * Who survives a fight for a slot. A shot may never silence a death; a death may
 * always silence a shot. Equal priorities fall back to oldest-first.
 */
const PRIO = { shot: 1, nearmiss: 1, refuel: 2, heart: 2, explosion: 3, alarm: 3, bridge: 4, death: 5 };

export class Sfx {
  constructor(ctx, dry, send, noise, rnd) {
    this.ctx = ctx;
    this.dry = dry;
    this.send = send;
    this.noise = noise;
    this.rnd = rnd;

    this.live = [];
    this.fading = [];
    this.free = [];

    // Retrigger guards. The integrator will call refuel() from a per-frame
    // overlap test and lowfuel() from a threshold that can chatter; both are
    // this module's problem to absorb, not the caller's.
    this.lastBlip = -1;
    this.lastAlarm = -1;
    this.fillHold = 0;
    this.fillOn = false;
    /** Latest tank level, pushed in by Audio so the refill can rise in pitch. */
    this.fuel01 = 1;

    // Sustained fire should thin out rather than pile up: nine identical
    // transients a second is a buzzsaw, and it also eats all the headroom the
    // explosions need.
    this.heat = 0;
    this.panFlip = 1;

    // --- refuelling hiss: one persistent voice, pumped rather than retriggered
    this.fillSrc = ctx.createBufferSource();
    this.fillSrc.buffer = noise;
    this.fillSrc.loop = true;
    this.fillSrc.playbackRate.value = 0.83;
    this.fillBp = biquad(ctx, 'bandpass', 700, 2.2);
    this.fillG = gain(ctx, 0);
    this.fillSrc.connect(this.fillBp);
    this.fillBp.connect(this.fillG);
    this.fillG.connect(dry);
    this.pFillF = new Smoothed(this.fillBp.frequency, 0.12, 5);
  }

  start(when) {
    this.fillSrc.start(when);
  }

  // ------------------------------------------------------------ voice budget

  #prune(now) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (this.live[i].until <= now) {
        this.#release(this.live[i]);
        this.live.splice(i, 1);
      }
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      if (this.fading[i].until <= now) {
        this.#release(this.fading[i]);
        this.fading.splice(i, 1);
      }
    }
  }

  #release(rec) {
    try {
      rec.out.disconnect();
      rec.pan.disconnect();
      rec.snd.disconnect();
    } catch (_) { /* already gone */ }
    rec.out = null;
    rec.pan = null;
    rec.snd = null;
    rec.srcs.length = 0;
    this.free.push(rec);
  }

  /** Returns true if a slot was freed. False means the newcomer must be dropped. */
  #steal(now, prio) {
    let worst = -1;
    let wp = Infinity;
    let wu = Infinity;
    for (let i = 0; i < this.live.length; i++) {
      const v = this.live[i];
      if (v.prio < wp || (v.prio === wp && v.until < wu)) {
        worst = i; wp = v.prio; wu = v.until;
      }
    }
    if (worst < 0) return false;
    if (wp > prio) return false;

    const rec = this.live[worst];
    this.live.splice(worst, 1);
    const g = rec.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.022);
    for (const s of rec.srcs) {
      try { s.stop(now + 0.03); } catch (_) { /* already stopped */ }
    }
    // Parked, not released: the ramp has to actually run before the nodes go.
    rec.until = now + 0.05;
    this.fading.push(rec);
    return true;
  }

  /**
   * Head of a voice: gain -> pan -> dry, plus a pre-pan tap to the canyon.
   * `life` is how long the voice can possibly sound; it is what retires the
   * nodes, so it must cover the longest envelope plus a little slack.
   */
  #voice(now, kind, life, pan, sendAmt) {
    const prio = PRIO[kind] || 1;
    this.#prune(now);
    if (this.live.length >= CAP && !this.#steal(now, prio)) return null;

    const ctx = this.ctx;
    const rec = this.free.pop() || { out: null, pan: null, snd: null, srcs: [], prio: 0, until: 0 };
    rec.out = gain(ctx, 1);
    rec.pan = ctx.createStereoPanner();
    rec.pan.pan.value = clamp(pan, -1, 1);
    rec.snd = gain(ctx, sendAmt);
    rec.out.connect(rec.pan);
    rec.pan.connect(this.dry);
    rec.out.connect(rec.snd);
    rec.snd.connect(this.send);
    rec.srcs.length = 0;
    rec.prio = prio;
    rec.until = now + life + 0.05;
    this.live.push(rec);
    return rec;
  }

  /**
   * Noise burst with a randomised read offset and rate, so no two instances of
   * a sound share a waveform. Looped because a long explosion tail played back
   * slowly consumes more buffer than exists, and a source that runs off the end
   * simply goes silent — the tail would vanish mid-decay. White noise has no
   * structure to give the loop point away.
   */
  #noise(rec, now, dur, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(now, this.rnd() * this.noise.duration);
    s.stop(now + dur + 0.02);
    rec.srcs.push(s);
    return s;
  }

  #osc(rec, now, type, dur) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.start(now);
    o.stop(now + dur + 0.02);
    rec.srcs.push(o);
    return o;
  }

  // ------------------------------------------------------------------- events

  /**
   * Cannon. Three layers on top of each other: a filtered noise spit (the
   * powder), a fast downward blip (the report) and a small thump (the recoil).
   * Alternating pan and a pitch spread mean a held trigger reads as a burst of
   * distinct rounds rather than as one sample on a metronome.
   */
  shot(now, level) {
    const heat = clamp01(this.heat / 6);
    const rec = this.#voice(now, 'shot', 0.22, this.panFlip * lerp(0.1, 0.2, this.rnd()), 0.22);
    this.panFlip = -this.panFlip;
    if (!rec) return;
    this.heat += 1;

    const v = this.rnd();
    const amp = level * lerp(0.9, 1.0, this.rnd()) * lerp(1, 0.55, heat);
    const ctx = this.ctx;

    const spit = this.#noise(rec, now, 0.09);
    const hp = biquad(ctx, 'highpass', lerp(1500, 2300, v), 0.8);
    const gs = gain(ctx, 1);
    ping(gs.gain, now, 0.30 * amp, 0.002, lerp(0.05, 0.075, this.rnd()));
    spit.connect(hp); hp.connect(gs); gs.connect(rec.out);

    const rep = this.#osc(rec, now, 'triangle', 0.13);
    sweep(rep.frequency, now, lerp(680, 880, v), lerp(140, 200, this.rnd()), 0.07);
    const gr = gain(ctx, 1);
    ping(gr.gain, now, 0.34 * amp, 0.002, 0.085);
    rep.connect(gr); gr.connect(rec.out);

    const thump = this.#osc(rec, now, 'sine', 0.12);
    sweep(thump.frequency, now, 150, 62, 0.07);
    const gt = gain(ctx, 1);
    ping(gt.gain, now, 0.22 * amp, 0.004, 0.07);
    thump.connect(gt); gt.connect(rec.out);
  }

  /**
   * Transient, body, tail — the three things an explosion is, and the reason a
   * single noise burst with a decay never sounds like one.
   *
   * The tail is sent hard to the canyon: it is the layer the gorge gets to work
   * on, and it is where the width of the world becomes audible.
   */
  explosion(now, level, pan, big, kind = 'explosion') {
    const life = big ? 2.4 : 1.7;
    const rec = this.#voice(now, kind, life, pan, big ? 0.85 : 0.62);
    if (!rec) return null;

    const ctx = this.ctx;
    const r = this.rnd;
    const amp = level * lerp(0.85, 1.15, r());
    const scale = big ? 1.5 : 1;

    // --- transient: the crack, gone in 60 ms -------------------------------
    const tr = this.#noise(rec, now, 0.1, lerp(0.9, 1.2, r()));
    const trHp = biquad(ctx, 'highpass', lerp(1800, 3200, r()), 0.7);
    const trG = gain(ctx, 1);
    ping(trG.gain, now, 0.5 * amp, 0.0015, lerp(0.04, 0.07, r()));
    tr.connect(trHp); trHp.connect(trG); trG.connect(rec.out);

    const crack = this.#osc(rec, now, 'square', 0.06);
    sweep(crack.frequency, now, lerp(1100, 1700, r()), 260, 0.035);
    const crG = gain(ctx, 1);
    ping(crG.gain, now, 0.14 * amp, 0.001, 0.035);
    crack.connect(crG); crG.connect(rec.out);

    // --- body: the collapsing resonance ------------------------------------
    const bodyDecay = lerp(0.34, 0.5, r()) * scale;
    const bd = this.#noise(rec, now, bodyDecay + 0.15, lerp(0.75, 1.05, r()));
    const bdLp = biquad(ctx, 'lowpass', 1200, lerp(3, 6, r()));
    sweep(bdLp.frequency, now, lerp(950, 1400, r()), lerp(90, 150, r()), bodyDecay);
    const bdG = gain(ctx, 1);
    ping(bdG.gain, now, 0.62 * amp * scale, 0.006, bodyDecay);
    bd.connect(bdLp); bdLp.connect(bdG); bdG.connect(rec.out);

    const sub = this.#osc(rec, now, 'sine', bodyDecay + 0.2);
    sweep(sub.frequency, now, lerp(130, 175, r()), lerp(32, 44, r()), bodyDecay * 0.9);
    const subG = gain(ctx, 1);
    ping(subG.gain, now, 0.5 * amp * scale, 0.008, bodyDecay + 0.1);
    sub.connect(subG); subG.connect(rec.out);

    // --- tail: what the canyon hears ---------------------------------------
    const tailDecay = lerp(0.9, 1.4, r()) * scale;
    const tl = this.#noise(rec, now, tailDecay + 0.2, lerp(0.6, 0.9, r()));
    const tlBp = biquad(ctx, 'bandpass', lerp(320, 560, r()), 0.6);
    const tlG = gain(ctx, 1);
    ping(tlG.gain, now, 0.3 * amp, 0.06, tailDecay);
    tl.connect(tlBp); tlBp.connect(tlG); tlG.connect(rec.out);

    return rec;
  }

  /**
   * A bridge coming down. The explosion, plus struck steel: four bandpass
   * resonators at inharmonic ratios. Inharmonic is the whole point — integer
   * ratios would sound like a bell, and a bell is not a bridge.
   */
  bridge(now, level, pan) {
    const rec = this.explosion(now, level * 1.25, pan, true, 'bridge');
    if (!rec) return;

    const ctx = this.ctx;
    const r = this.rnd;
    const base = lerp(165, 215, r());
    const ratios = [1, 1.71, 2.43, 3.29];

    const hit = this.#noise(rec, now, 0.05);
    const hitG = gain(ctx, 1);
    ping(hitG.gain, now, 1, 0.002, 0.03);
    hit.connect(hitG);

    for (let i = 0; i < ratios.length; i++) {
      const bp = biquad(ctx, 'bandpass', base * ratios[i] * lerp(0.97, 1.03, r()), 26);
      const g = gain(ctx, 1);
      ping(g.gain, now, (0.26 * level) / (1 + i * 0.55), 0.004, lerp(0.9, 1.6, r()));
      hitG.connect(bp); bp.connect(g); g.connect(rec.out);
    }

    // The span giving way under its own weight.
    const groan = this.#osc(rec, now, 'sawtooth', 1.5);
    sweep(groan.frequency, now, 92, 34, 1.3);
    const grLp = biquad(ctx, 'lowpass', 320, 1.2);
    const grG = gain(ctx, 1);
    ping(grG.gain, now, 0.2 * level, 0.05, 1.3);
    groan.connect(grLp); grLp.connect(grG); grG.connect(rec.out);
  }

  /**
   * The player. Bigger than any enemy explosion, plus an airframe tearing —
   * a bandpass dragged down two decades — and a sub drop under all of it.
   * Running out of fuel gets a softer, sadder version: no detonation, just the
   * fall. The engine's own spin-down (see EngineBed) carries the rest.
   */
  death(now, cause) {
    const soft = cause === 'fuel';
    const rec = this.explosion(now, soft ? 0.75 : 1.35, 0, true, 'death');
    if (!rec) return;

    const ctx = this.ctx;
    const tear = this.#noise(rec, now, 1.3, 0.85);
    const bp = biquad(ctx, 'bandpass', 2200, 3);
    sweep(bp.frequency, now, 2200, 170, 1.0);
    const g = gain(ctx, 1);
    ping(g.gain, now, soft ? 0.16 : 0.26, 0.02, 1.1);
    tear.connect(bp); bp.connect(g); g.connect(rec.out);

    const drop = this.#osc(rec, now, 'sine', 1.4);
    sweep(drop.frequency, now, 95, 24, 1.2);
    const dg = gain(ctx, 1);
    ping(dg.gain, now, 0.4, 0.03, 1.25);
    drop.connect(dg); dg.connect(rec.out);
  }

  /**
   * Air pushed aside. Swept bandpass on noise, panned *across* the head rather
   * than parked on one side, because the whole point of a near miss is that the
   * thing went past you.
   */
  nearmiss(now, level, pan) {
    const rec = this.#voice(now, 'nearmiss', 0.5, pan, 0.3);
    if (!rec) return;
    const ctx = this.ctx;
    const r = this.rnd;

    const src = this.#noise(rec, now, 0.42, lerp(0.9, 1.1, r()));
    const bp = biquad(ctx, 'bandpass', 300, 1.5);
    bp.frequency.setValueAtTime(320, now);
    bp.frequency.exponentialRampToValueAtTime(lerp(1500, 2100, r()), now + 0.14);
    bp.frequency.exponentialRampToValueAtTime(340, now + 0.36);
    const g = gain(ctx, 1);
    g.gain.setValueAtTime(SILENT, now);
    g.gain.exponentialRampToValueAtTime(0.34 * level, now + 0.07);
    g.gain.exponentialRampToValueAtTime(SILENT, now + 0.36);
    src.connect(bp); bp.connect(g); g.connect(rec.out);

    rec.pan.pan.setValueAtTime(clamp(pan, -1, 1), now);
    rec.pan.pan.linearRampToValueAtTime(clamp(-pan, -1, 1), now + 0.3);
  }

  /**
   * Fuelling. Two parts: a hiss layer that is *pumped* rather than retriggered,
   * so a caller hitting this every frame gets a continuous flow, and a blip
   * whose pitch rises with the tank level so the player can hear how full they
   * are without reading the gauge.
   */
  refuel(now, level) {
    this.fillHold = 0.1;
    if (!this.fillOn) {
      this.fillOn = true;
      this.fillG.gain.setTargetAtTime(0.075 * level, now, 0.02);
    }
    this.pFillF.set(lerp(420, 1500, clamp01(this.fuel01)), now);

    if (now - this.lastBlip < 0.13) return;
    this.lastBlip = now;

    const rec = this.#voice(now, 'refuel', 0.3, 0, 0.25);
    if (!rec) return;
    const ctx = this.ctx;
    const root = lerp(500, 760, clamp01(this.fuel01));
    for (let i = 0; i < 2; i++) {
      const o = this.#osc(rec, now, 'sine', 0.26);
      o.frequency.setValueAtTime(root * (i ? 1.5 : 1), now);
      const g = gain(ctx, 1);
      ping(g.gain, now, (i ? 0.07 : 0.11) * level, 0.006, 0.12);
      o.connect(g); g.connect(rec.out);
    }
  }

  /** Two-tone warning. Rate-limited hard: an alarm that nags is an alarm that gets muted. */
  alarm(now, level) {
    if (now - this.lastAlarm < 2.2) return;
    this.lastAlarm = now;

    const rec = this.#voice(now, 'alarm', 0.6, 0, 0.2);
    if (!rec) return;
    const ctx = this.ctx;
    const bp = biquad(ctx, 'bandpass', 1000, 1.4);
    bp.connect(rec.out);
    for (let i = 0; i < 2; i++) {
      const at = now + i * 0.19;
      const o = this.#osc(rec, at, 'square', 0.2);
      o.frequency.setValueAtTime(i ? 700 : 940, at);
      const g = gain(ctx, 1);
      ping(g.gain, at, 0.13 * level, 0.006, 0.13);
      o.connect(g); g.connect(bp);
    }
  }

  /**
   * Lub-dub, both beats in one voice. A single thump reads as a drum; the second,
   * weaker beat a fifth of a second later is what makes it a heart.
   */
  heartbeat(now, level, period) {
    const rec = this.#voice(now, 'heart', 0.7, 0, 0.12);
    if (!rec) return;
    const ctx = this.ctx;
    const lp = biquad(ctx, 'lowpass', 190, 1.1);
    lp.connect(rec.out);
    const gap = clamp(period * 0.3, 0.14, 0.24);

    for (let i = 0; i < 2; i++) {
      const at = now + i * gap;
      const amp = (i ? 0.42 : 0.72) * level;
      const o = this.#osc(rec, at, 'sine', 0.3);
      sweep(o.frequency, at, i ? 78 : 92, i ? 32 : 36, 0.13);
      const g = gain(ctx, 1);
      ping(g.gain, at, amp, 0.008, i ? 0.16 : 0.2);
      o.connect(g); g.connect(lp);

      const thud = this.#noise(rec, at, 0.1);
      const tg = gain(ctx, 1);
      ping(tg.gain, at, amp * 0.35, 0.004, 0.07);
      thud.connect(tg); tg.connect(lp);
    }
  }

  // -------------------------------------------------------------------- frame

  /** Allocation-free: bookkeeping only, no nodes are built here. */
  tick(now, dt) {
    this.#prune(now);
    this.heat = Math.max(0, this.heat - dt * 7);

    if (this.fillOn) {
      this.fillHold -= dt;
      if (this.fillHold <= 0) {
        this.fillOn = false;
        this.fillG.gain.setTargetAtTime(0, now, 0.07);
      }
    }
  }

  /**
   * Cut what is sounding. `maxPrio` exists because death is both a reason to
   * clear the mix and a sound in its own right: the caller fires the explosion
   * and then reports alive = false, so the cut must not be allowed to eat the
   * very thing it was triggered by.
   */
  silence(now, time = 0.08, maxPrio = Infinity) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const rec = this.live[i];
      if (rec.prio > maxPrio) continue;
      const g = rec.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + time);
      for (const s of rec.srcs) {
        try { s.stop(now + time + 0.01); } catch (_) { /* already stopped */ }
      }
      rec.until = now + time + 0.03;
      this.fading.push(rec);
      this.live.splice(i, 1);
    }
  }

  dispose(now) {
    this.silence(now, 0.02);
    this.#prune(now + 1e6);
    try { this.fillSrc.stop(now); } catch (_) { /* never started */ }
    try { this.fillG.disconnect(); } catch (_) { /* best effort */ }
  }
}
