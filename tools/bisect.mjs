import { chromium } from 'playwright';
import { preview } from 'vite';
import { PNG } from 'pngjs';

/**
 * Isolates a render failure by varying one thing at a time. Run with a list of
 * named trials; each opens a fresh page, optionally patches the live game via
 * `setup`, waits, and reports mean frame brightness from a real screenshot.
 *
 * Reads pixels from the composited screenshot, not from the WebGL canvas:
 * drawImage() on a WebGL canvas outside its own rAF returns black, because the
 * drawing buffer is discarded after compositing. That mistake cost an hour.
 */

const PORT = 4190;

export function meanLuma(png, { skipTop = 60, skipBottom = 60, step = 3 } = {}) {
  const p = PNG.sync.read(png);
  let sum = 0;
  let n = 0;
  for (let y = skipTop; y < p.height - skipBottom; y += step) {
    for (let x = 0; x < p.width; x += step) {
      const i = (p.width * y + x) << 2;
      sum += p.data[i] * 0.3 + p.data[i + 1] * 0.6 + p.data[i + 2] * 0.1;
      n++;
    }
  }
  return +(sum / n).toFixed(1);
}

export async function launch() {
  const server = await preview({ preview: { port: PORT, host: '127.0.0.1' }, logLevel: 'error' });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  return {
    browser,
    base: `http://127.0.0.1:${PORT}`,
    close: async () => { await browser.close(); await server.close(); },
  };
}

/** The harness's own frame-time probe: 90 rAF ticks, however long they take. */
const RAF_PROBE = `new Promise((res) => { let n = 0; const tick = () => (++n < 90 ? requestAnimationFrame(tick) : res(n)); requestAnimationFrame(tick); })`;

export async function trial(ctx, {
  name, width = 640, height = 360, warp = 6, setup, waits = [4000], rafProbe = false,
}) {
  const page = await ctx.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const gl = new Map();
  let counting = false;
  page.on('console', (m) => {
    if (!/GL_INVALID|shader|program/i.test(m.text())) return;
    const key = m.text().replace(/\[\.WebGL-[^\]]+\]\s*/, '').slice(0, 96);
    if (counting) gl.set(key, (gl.get(key) || 0) + 1);
  });
  await page.goto(`${ctx.base}/?auto&warp=${warp}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__rr !== undefined', null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  if (setup) await page.evaluate(setup);
  // Errors from before the patch are noise; only count what happens after it.
  await page.waitForTimeout(800);
  counting = true;

  if (rafProbe) await page.evaluate(RAF_PROBE);

  const lumas = [];
  for (const w of waits) {
    await page.waitForTimeout(w);
    lumas.push(meanLuma(await page.screenshot()));
  }
  const frames = await page.evaluate('window.__rr.renderer.info.render.frame');
  console.log(`${name.padEnd(30)} ${width}x${height}  luma: ${lumas.join('  ')}`);
  for (const [g, n] of gl) console.log(`    ! x${n} ${g}`);
  await page.close();
  return lumas;
}

// Standalone use: node tools/bisect.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = await launch();
  const HD = { width: 1280, height: 720 };
  const hide = (pred) => `window.__rr.scene.traverse(o => { if (${pred}) o.visible = false; })`;

  console.log('--- A: transient black at harness resolution ---');
  await trial(ctx, { name: 'HD, post on, 2s steps', ...HD, waits: [1000, 2000, 2000, 2000, 2000] });
  await trial(ctx, { name: 'HD, post bypassed', ...HD, waits: [1000, 2000, 2000],
    setup: `const rr = window.__rr; rr.post.render = () => rr.renderer.render(rr.scene, rr.camera);` });
  await trial(ctx, { name: 'HD, harness flow (rAF probe)', ...HD, rafProbe: true, waits: [200] });

  console.log('--- B: which object trips GL_INVALID_OPERATION ---');
  await trial(ctx, { name: 'baseline', waits: [3000] });
  await trial(ctx, { name: 'water hidden', waits: [3000],
    setup: hide(`o.isMesh && o.geometry?.type === 'PlaneGeometry'`) });
  await trial(ctx, { name: 'terrain hidden', waits: [3000],
    setup: `for (const [, m] of window.__rr.terrain.chunks) m.visible = false;` });
  await trial(ctx, { name: 'fx disposed', waits: [3000],
    setup: `window.__rr.game.fx.dispose(); window.__rr.game.fx.update = () => {};` });
  await trial(ctx, { name: 'plane + entities hidden', waits: [3000],
    setup: `const g = window.__rr.game; g.planeMesh.visible = false; for (const e of g.ents) if (e.mesh) e.mesh.visible = false; g.add = () => {};` });
  await ctx.close();
}
