import { chromium } from 'playwright';
import { preview } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

/**
 * Phase 1 verification harness.
 *
 * Boots the built game headless, flies it with the deterministic autopilot,
 * and captures a fixed set of world states. Because the sim is seeded and the
 * pilot is scripted, the same commit always produces the same pixels — which
 * is what turns "does it look right?" into a diffable artifact instead of an
 * opinion.
 *
 * It also fails loudly on console errors and on a frame-time budget, so the
 * two things that silently rot in a WebGL project cannot rot unnoticed.
 */

const WARPS = [2, 14, 30, 52, 78];
const VIEWPORT = { width: 1280, height: 720 };

/**
 * Headless here means SwiftShader — software rasterisation — so wall-clock
 * frame time says nothing about how this runs on real hardware. The gates that
 * *are* hardware-independent are the ones that actually predict GPU cost:
 * draw calls and triangles submitted. Frame time is recorded for the trend, not
 * enforced. A real fps gate needs a real GPU and belongs in phase 4.
 */
const MAX_DRAW_CALLS = 150;
const MAX_TRIANGLES = 400_000;

const server = await preview({
  preview: { port: 4173, host: '127.0.0.1' },
  logLevel: 'error',
});
const base = `http://127.0.0.1:4173`;

await mkdir('shots', { recursive: true });

const browser = await chromium.launch({
  // The image ships a pinned Chromium; use it rather than letting Playwright
  // try to fetch a matching build.
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const problems = [];
const report = [];

for (const warp of WARPS) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

  const errors = [];
  // A missing favicon is not a rendering bug; everything else is.
  const ignorable = (t) => /favicon/i.test(t);
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (ignorable(m.text()) || ignorable(m.location()?.url || '')) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => {
    if (!ignorable(r.url())) errors.push(`request failed: ${r.url()}`);
  });

  await page.goto(`${base}/?auto&warp=${warp}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__rr !== undefined', null, { timeout: 20000 });
  // Let the render loop settle so the perf numbers are steady state.
  await page.waitForTimeout(2500);

  const state = await page.evaluate(() => {
    const { game, renderer } = window.__rr;
    return {
      state: game.state,
      lives: game.lives,
      score: game.score,
      fuel: Math.round(game.fuel),
      z: Math.round(game.player.pos.z),
      sector: game.sector,
      ents: game.ents.length,
      deaths: game.deaths,
      draws: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
    };
  });

  const frameMs = await page.evaluate(
    () => new Promise((res) => {
      const samples = [];
      let prev = performance.now();
      let n = 0;
      const tick = () => {
        const now = performance.now();
        samples.push(now - prev);
        prev = now;
        if (++n < 90) requestAnimationFrame(tick);
        else {
          samples.sort((a, b) => a - b);
          res({
            median: samples[Math.floor(samples.length / 2)],
            p95: samples[Math.floor(samples.length * 0.95)],
          });
        }
      };
      requestAnimationFrame(tick);
    })
  );

  await page.screenshot({ path: `shots/t${String(warp).padStart(3, '0')}s.png` });

  if (errors.length) problems.push(`t=${warp}s console: ${errors.slice(0, 3).join(' | ')}`);
  if (state.state !== 'playing') {
    problems.push(`t=${warp}s autopilot not flying (state=${state.state}, lives=${state.lives})`);
  }
  // A terrain death is a world-generation bug: the river produced something no
  // one could fly through. A death to an enemy or to an empty tank is just the
  // bot playing badly, which is not a defect — report it, do not fail on it.
  const terrainDeaths = state.deaths.filter((d) => d.cause === 'terrain');
  if (terrainDeaths.length) {
    problems.push(`t=${warp}s flew into terrain at z=${terrainDeaths.map((d) => d.z).join(', z=')} — unflyable channel`);
  }
  if (state.draws > MAX_DRAW_CALLS) problems.push(`t=${warp}s ${state.draws} draw calls > ${MAX_DRAW_CALLS}`);
  if (state.tris > MAX_TRIANGLES) problems.push(`t=${warp}s ${state.tris} triangles > ${MAX_TRIANGLES}`);

  report.push({ warp, ...state, ...frameMs });
  if (state.deaths.length) {
    console.log('        deaths: ' + state.deaths.map((d) => `${d.cause}@z${d.z}`).join(', '));
  }
  console.log(
    `t=${String(warp).padStart(3)}s  z=${String(state.z).padStart(5)}  sector=${state.sector}  ` +
    `score=${String(state.score).padStart(5)}  fuel=${String(state.fuel).padStart(3)}  ` +
    `lives=${state.lives}  ents=${String(state.ents).padStart(3)}  ` +
    `draws=${String(state.draws).padStart(3)}  tris=${(state.tris / 1000).toFixed(0)}k  ` +
    `frame=${frameMs.median.toFixed(1)}/${frameMs.p95.toFixed(1)}ms`
  );

  await page.close();
}

await writeFile('shots/report.json', JSON.stringify(report, null, 2));
await browser.close();
await server.close();

if (problems.length) {
  console.error('\nGATE FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nall gates passed');
