import { FUEL_MAX } from '../game/game.js';
import { clamp01 } from '../core/math.js';

const $ = (id) => document.getElementById(id);
const BEST_KEY = 'rr3d.best';

export class Hud {
  constructor() {
    this.score = $('score');
    this.best = $('best');
    // Per-viewer, best effort: storage can be absent or throw (private window,
    // sandboxed frame). The game must not care either way.
    this.bestScore = 0;
    try { this.bestScore = Math.max(0, +localStorage.getItem(BEST_KEY) || 0); } catch { /* no storage */ }
    this.best.textContent = String(this.bestScore).padStart(5, '0');
    this.lives = $('lives');
    this.sector = $('sector');
    this.fuelBar = $('fuelbar');
    this.fuelFill = this.fuelBar.firstElementChild;
    this.speedFill = $('speedbar').firstElementChild;
    this.center = $('center');
    this.title = $('c-title');
    this.sub = $('c-sub');
    this.keysLine = $('c-keys');
    this.stick = $('stick');
    this.knob = $('knob');
    this.pauseBtn = $('pauseBtn');
    this.coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    // null, not '': the markup ships with the card visible, so the very first
    // showCard('') has to be seen as a change or a game that starts already
    // running (autopilot) keeps the title over the action forever.
    this._card = null;
    this.crosshair = $('crosshair');
    this.perf = $('perf');
    this.pulse = $('pulse');
    this.banner = $('banner');
    this._sector = 1;
    this.bannerT = 0;
    this._score = 0;
    this.edgeL = $('edgeL');
    this.edgeR = $('edgeR');

    this._lastState = 'playing';
    if (!this.perf.textContent) this.perf.style.display = 'none';
  }

  /** One card, four faces. Text is only written when the face changes. */
  showCard(key, title, sub, keys) {
    if (key === this._card) return;
    this._card = key;
    this.center.classList.toggle('hidden', !key);
    this.crosshair.style.opacity = key ? '0' : '';
    if (!key) return;
    this.title.textContent = title;
    this.sub.textContent = sub;
    this.keysLine.textContent = keys || '';
  }

  update(game, dt, input, perf, mode = 'run') {
    if (game.score !== this._score) {
      this._score = game.score;
      this.score.textContent = String(game.score).padStart(5, '0');
      // Restart the animation even if the previous one has not finished.
      this.score.classList.remove('pop');
      void this.score.offsetWidth;
      this.score.classList.add('pop');
    }

    // Sector banner: the bridge falling is the beat, the banner is its name.
    if (game.sector !== this._sector) {
      const advanced = game.sector > this._sector;
      this._sector = game.sector;
      if (advanced && game.state === 'playing') {
        this.banner.textContent = `SETOR ${game.sector}`;
        this.bannerT = 2.4;
      }
    }
    this.bannerT = Math.max(0, this.bannerT - dt);
    this.banner.style.opacity = Math.min(1, this.bannerT * 2.5, (2.4 - this.bannerT) * 4).toFixed(3);
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

    // Hints follow the device actually in use, not the one guessed at load.
    const touch = input.kind === 'touch' || (this.coarse && input.kind !== 'pad');
    const pad = input.kind === 'pad';

    if (game.state !== this._lastState) {
      this._lastState = game.state;
      if (game.state === 'gameover') {
        this._record = game.score > this.bestScore;
        if (this._record) {
          this.bestScore = game.score;
          this.best.textContent = String(this.bestScore).padStart(5, '0');
          try { localStorage.setItem(BEST_KEY, String(this.bestScore)); } catch { /* no storage */ }
        }
      }
    }

    if (mode === 'ready') {
      this.showCard(
        `ready-${touch}-${pad}`,
        'River Raid 3D',
        touch ? 'Toque para começar' : pad ? 'Aperte um botão para começar' : 'Aperte uma tecla ou clique para começar',
        touch ? 'Arraste para pilotar · para cima acelera, para baixo freia · o tiro é automático'
          : pad ? 'Analógico pilota · gatilhos aceleram e freiam · A atira · Start pausa'
          : 'A/D pilotar · W/S acelerar e frear · Espaço atirar · P pausa · M som'
      );
    } else if (mode === 'paused') {
      this.showCard(
        `paused-${touch}-${pad}`,
        'Pausado',
        touch ? 'Toque para continuar' : pad ? 'Start para continuar' : 'P ou qualquer tecla para continuar',
        ''
      );
    } else if (game.state === 'gameover') {
      this.showCard(
        `over-${game.score}-${touch}-${pad}`,
        this._record ? 'Novo recorde' : 'Fim de jogo',
        `${game.score} pontos · setor ${game.sector} · recorde ${this.bestScore}`,
        touch ? 'Toque para jogar de novo' : pad ? 'A para jogar de novo' : 'Enter para jogar de novo'
      );
    } else {
      this.showCard('');
    }

    // Floating stick: drawn where the thumb landed, so the player can see the
    // centre they are steering around.
    const t = input.touch;
    const stickOn = !!(t && t.active && mode === 'run');
    this.stick.style.opacity = stickOn ? '1' : '0';
    if (stickOn) {
      this.stick.style.transform = `translate(${t.x0}px, ${t.y0}px)`;
      this.knob.style.transform = `translate(${t.x - t.x0}px, ${t.y - t.y0}px)`;
    }
    this.pauseBtn.style.opacity = mode === 'run' && game.state === 'playing' ? '' : '0';

    if (perf) { this.perf.style.display = ''; this.perf.textContent = perf; }
  }
}
