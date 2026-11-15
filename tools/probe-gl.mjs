import { launch } from './bisect.mjs';

/**
 * Attributes GL errors to the program that raised them. Wraps every draw call
 * before the game loads and reads glGetError right after each one, so a
 * "GL_INVALID_OPERATION" stops being an anonymous console line and becomes
 * "drawElements, program PostFX.grade, rAF tick 2".
 */
const ctx = await launch();
const page = await ctx.browser.newPage({ viewport: { width: 640, height: 360 } });
await page.addInitScript(() => {
  window.__gl = { faults: [], tick: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { window.__gl.tick++; cb(t); });
  const P = WebGL2RenderingContext.prototype;
  for (const k of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const orig = P[k];
    P[k] = function (...a) {
      const r = orig.apply(this, a);
      const e = this.getError();
      if (e) window.__gl.faults.push({ k, e, prog: this.getParameter(this.CURRENT_PROGRAM), tick: window.__gl.tick });
      return r;
    };
  }
});
await page.goto(`${ctx.base}/?auto&warp=6`, { waitUntil: 'load' });
await page.waitForFunction('window.__rr !== undefined');
await page.waitForTimeout(9000);
const rows = await page.evaluate(() => {
  const progs = window.__rr.renderer.info.programs;
  const name = (p) => progs.find((q) => q.program === p)?.name ?? '(unknown program)';
  const g = new Map();
  for (const f of window.__gl.faults) {
    const key = `${f.k}  err=0x${f.e.toString(16)}  ${name(f.prog)}`;
    const v = g.get(key) ?? { n: 0, first: f.tick, last: f.tick };
    v.n++; v.last = f.tick; g.set(key, v);
  }
  return { ticks: window.__gl.tick, rows: [...g].map(([k, v]) => `${String(v.n).padStart(4)}x  ticks ${v.first}-${v.last}  ${k}`) };
});
console.log(`${rows.ticks} rAF ticks observed`);
console.log(rows.rows.join('\n') || 'no GL faults');
await page.close(); await ctx.close();
