import * as THREE from 'three';
import { Input } from './core/input.js';
import { Autopilot } from './core/autopilot.js';
import { Terrain } from './world/terrain.js';
import { Water } from './world/water.js';
import { riverHalfWidth } from './world/river.js';
import { Game, FUEL_MAX } from './game/game.js';
import { CameraRig } from './view/rig.js';
import { PostFX } from './view/post.js';
import { Hud } from './view/hud.js';
import { PositionMarker } from './view/marker.js';
import { Sky } from './view/sky.js';
import { MAX_ROLL } from './game/player.js';
import { setupLighting } from './view/lighting.js';
import { Audio } from './audio/audio.js';
import { GRADE } from './art/direction.js';

/**
 * Fixed 120 Hz simulation with render interpolation. The sim never sees a
 * variable timestep, so physics and feel are identical on a 60 Hz laptop and a
 * 144 Hz monitor; the renderer interpolates between the last two sim states so
 * motion stays smooth regardless of how the two rates line up.
 */
const SIM_HZ = 120;
const DT = 1 / SIM_HZ;
const MAX_FRAME = 0.25;

const params = new URLSearchParams(location.search);
const useAutopilot = params.has('auto');
const warpSeconds = parseFloat(params.get('warp') || '0');
// Three engine sounds behind a switch, so the one with ears picks the winner.
// Default is the variant the audio pass bet on — the engine that answers the
// stick and never sits still — until a pair of ears overrules it.
const engineVariant = params.get('engine') || 'c';
// Harness only: the autopilot is a survivability probe, and a game over stops
// the measurement. Every death is still reported; terrain deaths still fail.
const startLives = Math.max(1, parseInt(params.get('lives') || '3', 10) || 3);

// ------------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({
  // The composer never draws the scene to the default framebuffer, so MSAA on
  // the drawing buffer would allocate a multisampled target nothing renders
  // into. Anti-aliasing is SMAA's job, inside the post chain.
  antialias: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = GRADE.exposure;

/**
 * Every full-screen pass and the water's reflection pass are top-level
 * renderer.render() calls, and each one resets `info` on entry. Left on
 * autoReset, the stats would report only whatever the *last* pass submitted —
 * about one draw call — which would quietly turn the harness's draw-call and
 * triangle gates into decoration that can never fail. Reset once per frame
 * instead, at the top, so the numbers cover the whole frame.
 */
renderer.info.autoReset = false;

document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 2200);
// Layer 1 holds entities; the water's reflection camera deliberately does not
// see it (see ENTITY_LAYER in game.js).
camera.layers.enable(1);

// ---------------------------------------------------------------------- game

const audio = new Audio({ engine: engineVariant });
const terrain = new Terrain(scene);
const water = new Water(scene, renderer);
const game = new Game(scene, audio, { lives: startLives });
const rig = new CameraRig(camera);
const lighting = setupLighting(scene, renderer);

// The water's reflection pass is a second full renderer.render() per frame,
// and by default each render re-draws every shadow caster into the shadow map.
// Shadows are light-space and camera-independent, so once per frame is enough:
// flag it at the top of the frame, and whichever render runs first does it.
renderer.shadowMap.autoUpdate = false;
const post = new PostFX(renderer, scene, camera);
const hud = new Hud();
const marker = new PositionMarker(scene);
const sky = new Sky(scene);

const keyboard = new Input(window);
const autopilot = useAutopilot ? new Autopilot(game) : null;
const input = autopilot ?? keyboard;

// Browsers refuse to start an AudioContext outside a user gesture. resume() is
// idempotent and cheap after the first success, so the simplest correct hook is
// every keydown.
window.addEventListener('keydown', () => audio.resume());
renderer.domElement.tabIndex = 0;
renderer.domElement.addEventListener('pointerdown', () => {
  renderer.domElement.focus();
  audio.resume();
});
renderer.domElement.focus();

terrain.prime(game.player.pos.z);

// Fast-forward the sim deterministically before the first frame. Used by the
// screenshot harness so a capture always lands on the same world state.
if (warpSeconds > 0) {
  const steps = Math.round(warpSeconds * SIM_HZ);
  for (let i = 0; i < steps; i++) {
    if (autopilot) autopilot.update();
    game.step(DT, input);
  }
  terrain.prime(game.player.pos.z);
}

/**
 * Warm-up render, discarded. Measured, not guessed: on the very first frame the
 * water's reflection pass is the first renderer.render() of the session, so it
 * is also the first render of the shadow map — and a shadow map born inside a
 * render to a custom target comes up with its depth texture mis-parameterised.
 * Every draw that frame then fails with "texture format / sampler type
 * mismatch" (31 of them), and the frame is garbage. Rendering once to the
 * default framebuffer first, shadows included, makes the fault vanish; a
 * warm-up with shadows disabled does not. It also front-loads every shader
 * compile, so the first real frame does not hitch.
 */
renderer.shadowMap.needsUpdate = true;
sky.update(camera, game.player.pos.z);
renderer.render(scene, camera);

// ---------------------------------------------------------------------- loop

let last = performance.now();
let acc = 0;

const frameTimes = new Float32Array(120);
let ftIndex = 0;
let perfText = '';
let perfClock = 0;

function frame(now) {
  requestAnimationFrame(frame);

  const raw = (now - last) / 1000;
  last = now;
  const frameDt = Math.min(raw, MAX_FRAME);

  renderer.info.reset();

  acc += frameDt;
  let steps = 0;
  while (acc >= DT && steps < 240) {
    if (autopilot) autopilot.update();
    game.step(DT, input);
    acc -= DT;
    steps++;
  }
  const alpha = acc / DT;

  terrain.update(game.player.pos.z, 1);
  lighting.update(frameDt, game.player.pos.z, game.player.pos.x);
  renderer.shadowMap.needsUpdate = true;
  game.render(alpha);
  marker.update(game.planeMesh.position, game.state === 'playing');

  // Effects run on the sim clock, not wall time, so a hitstop freezes them with
  // the world — the held bright frame is the punch — and so the harness's
  // seeded runs stay pixel-reproducible.
  game.fx.update(frameDt, game.time);

  // The water needs the camera's final pose for the frame: it renders its own
  // mirrored view before the main pass.
  rig.update(frameDt, game);
  sky.update(camera, game.player.pos.z);
  water.update(frameDt, game.time, game.player.pos.z, camera);
  post.blurScale = 1 - 0.85 * game.shake;

  audio.update(frameDt, {
    speed01: game.player.speed01,
    fuel01: game.fuel / FUEL_MAX,
    canyonHalfWidth: riverHalfWidth(game.player.pos.z),
    alive: game.state === 'playing',
    playerZ: game.player.pos.z,
    // The sim owns the tension clock; audio and HUD both follow it.
    low01: game.lowMix,
    beat: game.beatEdge,
    roll01: game.player.roll / MAX_ROLL,
  });

  // Replaces renderer.render: tone mapping now happens inside the grade pass,
  // because three only applies renderer.toneMapping when drawing straight to
  // the canvas and everything here goes through render targets first.
  post.render(frameDt, game.time);

  // --- perf readout -------------------------------------------------------
  frameTimes[ftIndex] = raw * 1000;
  ftIndex = (ftIndex + 1) % frameTimes.length;
  perfClock += frameDt;
  if (perfClock > 0.4) {
    perfClock = 0;
    let sum = 0;
    let worst = 0;
    for (const t of frameTimes) { sum += t; if (t > worst) worst = t; }
    const avg = sum / frameTimes.length;
    perfText =
      `${(1000 / avg).toFixed(0)} fps  ${avg.toFixed(1)}ms avg  ${worst.toFixed(1)}ms max\n` +
      `${renderer.info.render.calls} draws  ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris`;
  }

  hud.update(game, frameDt, input, perfText);
}

requestAnimationFrame(frame);

// --------------------------------------------------------------------- misc

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
  water.setSize(window.innerWidth, window.innerHeight);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { last = performance.now(); acc = 0; }
});

// Handle for the screenshot / benchmark harness.
window.__rr = { game, terrain, water, rig, post, audio, renderer, scene, camera, DT, SIM_HZ, THREE };
