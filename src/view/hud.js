import { FUEL_MAX } from '../game/game.js';
import { clamp01 } from '../core/math.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.score = $('score');
    this.lives = $('lives');
    this.sector = $('sector');
    this.fuelBar = $('fuelbar');
    this.fuelFill = this.fuelBar.firstElementChild;
    this.speedFill = $('speedbar').firstElementChild;
    this.center = $('center');
    this.title = $('c-title');
    this.sub = $('c-sub');
    this.perf = $('perf');
    this.pulse = $('pulse');
    this.edgeL = $('edgeL');
    this.edgeR = $('edgeR');

    this.introT = 0;
    this.dismissed = false;
    this._lastState = 'playing';
  }

  update(game, dt, input, perf) {
    this.score.textContent = String(game.score).padStart(5, '0');
    this.lives.textContent = String(Math.max(0, game.lives));
    this.sector.textContent = String(game.sector);

    const f = clamp01(game.fuel / FUEL_MAX);
    this.fuelFill.style.transform = `scaleX(${f})`;
    this.fuelBar.className =
      'bar' + (f < 0.15 ? ' crit' : f < 0.3 ? ' warn' : '') + (game.leakT > 0 ? ' leak' : '');

    // Heartbeat on the screen edge: a hard flash on the beat that decays until
    // the next one, same clock the audio uses. Amber while warning, red once
    // it is an emergency — and faster, because the sim's bpm climbs with it.
    const playing = game.state === 'playing';
    const beat = Math.pow(1 - game.beatPhase, 3);
    this.pulse.style.opacity = playing ? (game.lowMix * (0.25 + 0.75 * beat)).toFixed(3) : '0';
    this.pulse.classList.toggle('red', game.emergency);

    // Bank proximity, per side. A graze turns the whole edge red.
    const gl = game.grazing && game.shoreL >= game.shoreR;
    const gr = game.grazing && game.shoreR > game.shoreL;
    this.edgeL.style.opacity = playing ? (gl ? 1 : game.shoreL * game.shoreL).toFixed(3) : '0';
    this.edgeR.style.opacity = playing ? (gr ? 1 : game.shoreR * game.shoreR).toFixed(3) : '0';
    this.edgeL.classList.toggle('hit', gl);
    this.edgeR.classList.toggle('hit', gr);

    this.speedFill.style.transform = `scaleX(${game.player.speed01.toFixed(3)})`;

    // Intro card clears on the first input, or on its own after a few seconds.
    this.introT += dt;
    if (!this.dismissed && (this.introT > 4.5 || input.lateral || input.throttle || input.firing)) {
      this.dismissed = true;
    }

    if (game.state !== this._lastState) {
      const prev = this._lastState;
      this._lastState = game.state;
      if (game.state === 'gameover') {
        this.title.textContent = 'Fim de jogo';
        this.sub.textContent = `Pontos ${game.score} · Setor ${game.sector} · Enter para reiniciar`;
        this.dismissed = false;
        this.introT = 0;
      } else if (prev === 'gameover') {
        this.dismissed = true;
      }
    }

    const showCenter = game.state === 'gameover' || !this.dismissed;
    this.center.classList.toggle('hidden', !showCenter);

    if (perf) this.perf.textContent = perf;
  }
}
