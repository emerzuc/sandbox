import { clamp } from './math.js';

/**
 * Keyboard, touch and gamepad behind one interface.
 *
 * Input is sampled from the event stream, never from the render loop, so a
 * press that starts and ends between two frames is still seen by the sim.
 * Edges (fire, restart, start, pause, mute) latch until something consumes them.
 *
 * `lateral` and `throttle` are analog in [-1, 1]. The keyboard only ever
 * produces -1/0/+1; a thumb or a stick produces everything in between, and the
 * player model already treats the value as a target velocity, so analog input
 * needed no change downstream.
 */

/** Thumb travel, in CSS pixels, from the touch origin to full deflection. */
const STICK_PX = 54;
const THROTTLE_PX = 64;
const PAD_DEADZONE = 0.18;

export class Input {
  /**
   * @param target  receives key events (window)
   * @param surface receives pointer events (the canvas); optional
   */
  constructor(target = window, surface = null) {
    this.keys = new Set();
    this.firedEdge = false;
    this.restartEdge = false;
    this.startEdge = false;
    this.pauseEdge = false;
    this.muteEdge = false;

    /** Last device that produced input: decides which hints the HUD shows. */
    this.kind = 'keys';

    // One floating stick: wherever the first finger lands is the centre.
    this.touch = { active: false, id: -1, x0: 0, y0: 0, x: 0, y: 0, lat: 0, thr: 0 };
    this.pad = { lat: 0, thr: 0, fire: false, prev: 0 };

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      this.kind = 'keys';
      // Mute is a setting, not an intent to play: it must not start or resume.
      if (c !== 'KeyM') this.startEdge = true;
      if (c === 'Space') this.firedEdge = true;
      if (c === 'Enter' || c === 'KeyR') this.restartEdge = true;
      if (c === 'KeyP' || c === 'Escape') this.pauseEdge = true;
      if (c === 'KeyM') this.muteEdge = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) {
        e.preventDefault();
      }
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => { this.keys.clear(); this.#releaseTouch(); });

    if (surface) this.#bindPointer(surface);
  }

  #bindPointer(surface) {
    const t = this.touch;

    surface.addEventListener('pointerdown', (e) => {
      // Any press starts the game and, on the game-over card, restarts it.
      this.startEdge = true;
      this.restartEdge = true;
      if (e.pointerType === 'mouse') return;

      this.kind = 'touch';
      if (t.active) return; // second finger: ignored, the first one is flying
      t.active = true;
      t.id = e.pointerId;
      t.x0 = t.x = e.clientX;
      t.y0 = t.y = e.clientY;
      t.lat = 0;
      t.thr = 0;
      this.firedEdge = true;
      try { surface.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      e.preventDefault();
    });

    surface.addEventListener('pointermove', (e) => {
      if (!t.active || e.pointerId !== t.id) return;
      t.x = e.clientX;
      t.y = e.clientY;

      // The origin trails the thumb once it passes full deflection, so
      // reversing direction responds at once instead of after a long drag back.
      const dx = t.x - t.x0;
      if (Math.abs(dx) > STICK_PX) t.x0 = t.x - Math.sign(dx) * STICK_PX;
      const dy = t.y - t.y0;
      if (Math.abs(dy) > THROTTLE_PX) t.y0 = t.y - Math.sign(dy) * THROTTLE_PX;

      t.lat = clamp((t.x - t.x0) / STICK_PX, -1, 1);
      // Throttle is a deliberate push, not a by-product of steering: a wide
      // dead band, then all-or-nothing like the keys.
      const v = -(t.y - t.y0) / THROTTLE_PX;
      t.thr = v > 0.6 ? 1 : v < -0.6 ? -1 : 0;
    });

    const end = (e) => { if (e.pointerId === t.id) this.#releaseTouch(); };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);
  }

  #releaseTouch() {
    const t = this.touch;
    t.active = false;
    t.id = -1;
    t.lat = 0;
    t.thr = 0;
  }

  /**
   * Gamepads have no events worth the name; poll once per frame. Standard
   * mapping: left stick or d-pad steers, triggers are throttle and brake,
   * A / X / RB fire, Start pauses.
   */
  poll() {
    const p = this.pad;
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    let gp = null;
    if (pads) for (const g of pads) { if (g && g.connected) { gp = g; break; } }
    if (!gp) { p.lat = 0; p.thr = 0; p.fire = false; p.prev = 0; return; }

    const b = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
    const ax = gp.axes[0] || 0;
    let lat = Math.abs(ax) > PAD_DEADZONE ? (ax - Math.sign(ax) * PAD_DEADZONE) / (1 - PAD_DEADZONE) : 0;
    if (b(14) > 0.5) lat = -1;
    if (b(15) > 0.5) lat = 1;
    p.lat = clamp(lat, -1, 1);

    const trig = b(7) - b(6);
    const ay = -(gp.axes[1] || 0);
    p.thr = Math.abs(trig) > 0.25 ? Math.sign(trig) : ay > 0.6 || b(12) > 0.5 ? 1 : ay < -0.6 || b(13) > 0.5 ? -1 : 0;
    p.fire = b(0) > 0.5 || b(2) > 0.5 || b(5) > 0.5;

    // Rising edges, packed into a bitmask so no per-frame array is needed.
    let mask = 0;
    for (let i = 0; i < Math.min(gp.buttons.length, 16); i++) if (b(i) > 0.5) mask |= 1 << i;
    const rose = mask & ~p.prev;
    p.prev = mask;
    if (rose || p.lat || p.thr) this.kind = 'pad';
    if (rose) this.startEdge = true;
    if (rose & 1) { this.firedEdge = true; this.restartEdge = true; }
    if (rose & (1 << 9)) { this.pauseEdge = true; this.restartEdge = true; }
  }

  down(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  /** -1 left .. +1 right */
  get lateral() {
    const k = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    if (k) return k;
    return this.touch.active ? this.touch.lat : this.pad.lat;
  }

  /** -1 brake .. +1 boost */
  get throttle() {
    const k = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    if (k) return k;
    return this.touch.active ? this.touch.thr : this.pad.thr;
  }

  /** A thumb has no spare finger for a trigger: touching *is* firing. */
  get firing() {
    return this.down('Space') || this.touch.active || this.pad.fire;
  }

  #take(name) {
    const v = this[name];
    this[name] = false;
    return v;
  }

  /** True once per physical press. */
  consumeFire() { return this.#take('firedEdge'); }
  consumeRestart() { return this.#take('restartEdge'); }
  consumeStart() { return this.#take('startEdge'); }
  consumePause() { return this.#take('pauseEdge'); }
  consumeMute() { return this.#take('muteEdge'); }

  /** Drop everything latched — used when leaving the title card or a pause. */
  flush() {
    this.firedEdge = this.restartEdge = this.startEdge = this.pauseEdge = false;
  }
}
