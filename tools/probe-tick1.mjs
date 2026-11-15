import { launch } from './bisect.mjs';

/**
 * Faults that only happen on the first frame need patching *before* the first
 * frame. main.js assigns window.__rr synchronously at the end of its module,
 * and the first rAF fires after that task — so a setter on __rr runs in the
 * gap, with the whole game constructed and nothing rendered yet.
 */
const ctx = await launch();
const trials = [
  ['control', ``],
  ['shadows off before tick 1', `rr.renderer.shadowMap.enabled = false;`],
  ['reflection off before tick 1', `rr.water.update = () => {};`],
  ['post bypassed before tick 1', `rr.post.render = () => rr.renderer.render(rr.scene, rr.camera);`],
  ['warm-up render before tick 1', `window.__gl.phase = 'warmup'; rr.renderer.render(rr.scene, rr.camera); window.__gl.phase = 'loop';`],
  ['warm-up, shadows off during warm-up only', `window.__gl.phase = 'warmup'; rr.renderer.shadowMap.enabled = false; rr.renderer.render(rr.scene, rr.camera); rr.renderer.shadowMap.enabled = true; rr.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); }); window.__gl.phase = 'loop';`],
];
for (const [name, patch] of trials) {
  const page = await ctx.browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.addInitScript((patch) => {
    window.__gl = { faults: [], tick: 0, phase: 'loop' };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => { window.__gl.tick++; cb(t); });
    const P = WebGL2RenderingContext.prototype;
    for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const orig = P[k];
      P[k] = function (...a) { const r = orig.apply(this, a); const e = this.getError(); if (e) window.__gl.faults.push({ k, e, tick: window.__gl.tick, phase: window.__gl.phase }); return r; };
    }
    let val;
    Object.defineProperty(window, '__rr', { configurable: true, get: () => val, set: (v) => { val = v; try { new Function('rr', patch)(v); } catch (e) { window.__gl.patchError = String(e); } } });
  }, patch);
  await page.goto(`${ctx.base}/?auto&warp=6`, { waitUntil: 'load' });
  await page.waitForFunction('window.__rr !== undefined');
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const g = window.__gl; const by = {};
    for (const f of g.faults) { const k = `${f.phase}/tick${f.tick}`; by[k] = (by[k] || 0) + 1; }
    return { by, ticks: g.tick, err: g.patchError };
  });
  console.log(`${name.padEnd(42)} faults: ${Object.entries(r.by).map(([k, n]) => `${k}=${n}`).join(', ') || 'none'}   (${r.ticks} ticks)${r.err ? '  PATCH ERROR: ' + r.err : ''}`);
  await page.close();
}
await ctx.close();
