/**
 * Input is sampled from the event stream, never from the render loop, so a
 * keypress that starts and ends between two frames is still seen by the sim.
 * `firedEdge` latches a press until a sim step consumes it.
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.firedEdge = false;
    this.restartEdge = false;

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const c = e.code;
      this.keys.add(c);
      if (c === 'Space') this.firedEdge = true;
      if (c === 'Enter' || c === 'KeyR') this.restartEdge = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) {
        e.preventDefault();
      }
    });

    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  down(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  /** -1 left .. +1 right */
  get lateral() {
    return (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
  }

  /** -1 brake .. +1 boost */
  get throttle() {
    return (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
  }

  get firing() {
    return this.down('Space');
  }

  /** True once per physical press. */
  consumeFire() {
    const f = this.firedEdge;
    this.firedEdge = false;
    return f;
  }

  consumeRestart() {
    const r = this.restartEdge;
    this.restartEdge = false;
    return r;
  }
}
