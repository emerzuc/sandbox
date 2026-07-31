import * as THREE from 'three';
import { Input } from './core/input.js';
import { Autopilot } from './core/autopilot.js';
import { Terrain } from './world/terrain.js';
import { Game } from './game/game.js';
import { CameraRig } from './view/rig.js';
import { Hud } from './view/hud.js';

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

// ------------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const SKY = 0x9fb6c6;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 330, 930);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 2200);

// Key light is deliberately raking rather than overhead: with flat shading it
// is the only thing separating one grey facet from the next.
const key = new THREE.DirectionalLight(0xfff2e0, 2.1);
key.position.set(-160, 190, 90);
scene.add(key);
scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x4a4f52, 0.85));

// ---------------------------------------------------------------------- game

const terrain = new Terrain(scene);
const game = new Game(scene);
const rig = new CameraRig(camera);
const hud = new Hud();

const keyboard = new Input(window);
const autopilot = useAutopilot ? new Autopilot(game) : null;
const input = autopilot ?? keyboard;

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
  game.render(alpha);
  rig.update(frameDt, game);
  renderer.render(scene, camera);

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
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { last = performance.now(); acc = 0; }
});

// Handle for the screenshot / benchmark harness.
window.__rr = { game, terrain, rig, renderer, scene, camera, DT, SIM_HZ };
